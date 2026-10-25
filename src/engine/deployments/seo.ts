export interface Finding {
  path: string;
  problem: string;
}

export interface SeoReview {
  pages: string[];
  indexable: string[];
  problems: Finding[];
  warnings: Finding[];
}

export function pagePathOf(file: string): string | null {
  if (file === 'index.html') return '/';
  if (!file.endsWith('/index.html')) return null;
  return `/${file.slice(0, -'/index.html'.length)}`;
}

export function pageFilesOf(route: string): string[] {
  if (route === '/') return ['index.html', '_root.data'];
  const name = route.replace(/^\/+|\/+$/g, '');
  return [`${name}/index.html`, `${name}.data`];
}

const attribute = (html: string, pattern: RegExp) => pattern.exec(html)?.[1]?.trim() ?? '';

export function seoReview(files: Map<string, Buffer>, options: { canonical: boolean }): SeoReview {
  const review: SeoReview = { pages: [], indexable: [], problems: [], warnings: [] };
  for (const [file, bytes] of files) {
    const route = pagePathOf(file);
    if (!route) continue;
    const html = bytes.toString('utf8');
    review.pages.push(route);
    const noindex = /<meta name="robots" content="[^"]*noindex/.test(html);
    if (!noindex && route !== '/cart') review.indexable.push(route);
    if (!attribute(html, /<title>([^<]*)<\/title>/)) review.problems.push({ path: route, problem: 'has no title' });
    if (!attribute(html, /<meta name="description" content="([^"]*)"/)) review.warnings.push({ path: route, problem: 'has no description' });
    if (!noindex && route !== '/cart' && !attribute(html, /<link rel="canonical" href="([^"]*)"/)) {
      (options.canonical ? review.problems : review.warnings).push({ path: route, problem: options.canonical ? 'has no canonical URL' : 'has no canonical URL (the kit adds one from version 1.1.0)' });
    }
    if (route.startsWith('/products/') && !/<script type="application\/ld\+json">[^<]*"@type":"Product"/.test(html)) review.problems.push({ path: route, problem: 'has no product JSON-LD' });
  }
  if (!files.has('__spa-fallback.html')) review.problems.push({ path: '/', problem: "has no app shell for pages that aren't rendered yet" });
  review.pages.sort();
  review.indexable.sort();
  return review;
}

const escapeXml = (value: string) => value.replace(/[<>&'"]/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char]!);

export function sitemapXml(siteUrl: string, routes: string[]): string {
  const urls = routes.map(route => `  <url><loc>${escapeXml(`${siteUrl}${route === '/' ? '/' : route}`)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function robotsTxt(siteUrl: string): string {
  return `User-agent: *\nAllow: /\nDisallow: /cart\n\nSitemap: ${siteUrl}/sitemap.xml\n`;
}
