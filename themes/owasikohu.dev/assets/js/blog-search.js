const root = document.querySelector("#blog-search");

if (root) {
  const form = root.querySelector("form");
  const input = root.querySelector("input[type='search']");
  const status = root.querySelector("[role='status']");
  const results = root.querySelector("#blog-search-results");
  let pagefind;

  const setStatus = (message) => {
    status.textContent = message;
  };

  const renderResult = (item) => {
    const article = document.createElement("article");
    article.className = "search-result";

    const title = document.createElement("h2");
    title.className = "search-result__title";
    const link = document.createElement("a");
    link.href = item.url;
    link.textContent = item.meta?.title || item.url;
    title.append(link);

    const excerpt = document.createElement("p");
    excerpt.textContent = item.plain_excerpt || "";
    article.append(title, excerpt);
    return article;
  };

  const search = async () => {
    const query = input.value.trim();
    results.replaceChildren();

    if (!query) {
      setStatus("");
      return;
    }

    setStatus("検索中…");

    try {
      pagefind ||= await import(root.dataset.pagefindUrl);
      const response = await pagefind.search(query);
      const items = await Promise.all(response.results.slice(0, 20).map((result) => result.data()));
      const blogItems = items.filter((item) => item.url.startsWith("/blog/") && !item.url.startsWith("/blog/search/"));
      results.append(...blogItems.map(renderResult));
      setStatus(`${blogItems.length}件見つかりました。`);
    } catch {
      setStatus("検索インデックスを読み込めませんでした。本番ビルド後に利用できます。");
    }
  };

  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(search, 180);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    clearTimeout(timer);
    search();
  });
}
