// scripts/generate.js
const fs = require("fs");
const path = require("path");
const nodeFetch = require('node-fetch');
const { JSDOM } = require("jsdom");

const GH_USER = process.env.GH_USER || "stevan-milovanovic";
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
    console.error("GITHUB_TOKEN missing");
    process.exit(1);
}

const GRAPHQL = async (query, vars = {}) => {
    const res = await nodeFetch("https://api.github.com/graphql", {
        method: "POST",
        headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: vars })
    });
    return res.json();
};

const download = async (url, dest) => {
    try {
        const res = await nodeFetch(url);
        if (!res.ok) return false;
        const buffer = await res.buffer();
        fs.writeFileSync(dest, buffer);
        return true;
    } catch (e) {
        return false;
    }
};

(async () => {
    // 1) Get pinned repositories
    const q = `
    query($login:String!){
      user(login:$login){
        pinnedItems(first:10, types: REPOSITORY) {
          nodes {
            ... on Repository {
              name
              description
              url
              stargazerCount
              forkCount
              primaryLanguage { name color }
              defaultBranchRef { name }
            }
          }
        }
      }
    }`;
    const data = await GRAPHQL(q, { login: GH_USER });
    const repos = data.data.user.pinnedItems.nodes || [];

    // Prepare assets folder
    const assetsDir = path.join(process.cwd(), "assets");
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir);

    // 2) For each repo, fetch README raw HTML and extract first image src
    const cards = [];
    for (const r of repos) {
        const repoFull = `${GH_USER}/${r.name}`;
        // Try to fetch raw README from GitHub raw content (default branch)
        const branch = r.defaultBranchRef?.name || "main";
        const rawReadmeUrls = [
            `https://raw.githubusercontent.com/${repoFull}/${branch}/README.md`,
            `https://raw.githubusercontent.com/${repoFull}/${branch}/readme.md`
        ];

        let readmeText = null;
        for (const u of rawReadmeUrls) {
            try {
                const res = await nodeFetch(u);
                if (res.ok) {
                    readmeText = await res.text();
                    break;
                }
            } catch (e) {}
        }

        let imgLocal = null;
        if (readmeText) {
            // Convert markdown image references to HTML to extract first image
            // quick heuristic: look for markdown image ![alt](url) or HTML <img>
            const mdImgMatch = readmeText.match(/!\[.*?\]\((.*?)\)/i);
            let imgUrl = mdImgMatch ? mdImgMatch[1].split('"')[0] : null;
            if (!imgUrl) {
                const htmlImgMatch = readmeText.match(/<img[^>]*src=["']([^"']+)["'][^>]*>/i);
                imgUrl = htmlImgMatch ? htmlImgMatch[1] : null;
            }
            if (imgUrl) {
                // Normalize relative URLs to raw.githubusercontent.com
                if (
                    imgUrl.startsWith("./") ||
                    imgUrl.startsWith("../") ||
                    imgUrl.startsWith("images/") ||
                    !/^https?:\/\//i.test(imgUrl)
                ) {
                    // build raw URL from repo
                    const cleaned = imgUrl.replace(/^\.\//, "");
                    const possible = `https://raw.githubusercontent.com/${repoFull}/${branch}/${cleaned}`;
                    imgUrl = possible;
                }
                const ext = (path.extname(new URL(imgUrl, "https://example.com").pathname) || ".png").split("?")[0];
                const localName = `${r.name.replace(/[^a-z0-9\-]/gi, "_")}${ext}`;
                const dest = path.join(assetsDir, localName);
                const ok = await download(imgUrl, dest);
                if (ok) imgLocal = `assets/${localName}`;
            }
        }

        cards.push({
            name: r.name,
            desc: r.description || "",
            url: r.url,
            stars: r.stargazerCount || 0,
            forks: r.forkCount || 0,
            lang: r.primaryLanguage?.name || "",
            img: imgLocal
        });
    }

    // 3) Load template and inject cards
    const template = fs.readFileSync("src/template.html", "utf8");
    const cardHtml = cards
        .map((c) => {
            const imgTag = c.img ? `<div class="thumb"><img src="${c.img}" alt="${c.name} screenshot"></div>` : "";
            return `<article class="card">
      ${imgTag}
      <div class="meta">
        <h3><a href="${c.url}" target="_blank" rel="noopener">${c.name}</a></h3>
        <p class="desc">${(c.desc || "").replace(/\n/g, " ")}</p>
        <p class="stats">⭐ ${c.stars} • 🍴 ${c.forks} ${c.lang ? "• " + c.lang : ""}</p>
      </div>
    </article>`;
        })
        .join("\n");

    const out = template
        .replace("<!-- REPO_CARDS -->", cardHtml)
        .replace("<!-- UPDATED_AT -->", new Date().toISOString());
    fs.writeFileSync("index.html", out, "utf8");
    console.log("index.html generated with", cards.length, "cards");
})();
