/**
 * Detects if a webpage uses Svelte/SvelteKit or Astro+Svelte by checking for
 * Svelte-specific attributes, SvelteKit navigation markers, and Astro island
 * elements whose renderer is the Svelte adapter.
 *
 * @param $ - The Cheerio API object containing the parsed HTML
 * @returns Promise that resolves to an object with detection status and evidence
 */
export const checkSvelte = async ($) => {
    let detected = false;
    let evidence = "";

    // SvelteKit: /_app/immutable/ path in src or href attributes (SvelteKit build output)
    $("*").each((_, el) => {
        if (detected) return;
        const src = $(el).attr("src");
        const href = $(el).attr("href");
        if (src && src.includes("/_app/immutable/")) {
            detected = true;
            evidence = `${$(el).get(0).tagName} src :: ${src}`;
        } else if (href && href.includes("/_app/immutable/")) {
            detected = true;
            evidence = `${$(el).get(0).tagName} href :: ${href}`;
        }
    });

    if (detected) return { detected, evidence };

    // SvelteKit: svelte- prefixed class names or IDs
    $("*").each((_, el) => {
        const attribs = el.attribs;
        if (!attribs) return;
        for (const [attrName, attrValue] of Object.entries(attribs)) {
            if (attrName === "class" || attrName === "id") {
                if ((attrValue as string).includes("svelte-")) {
                    detected = true;
                    evidence = `${attrName} :: ${attrValue}`;
                }
            }
        }
    });

    // SvelteKit: data-sveltekit-reload or other data-sveltekit-* attributes
    $("*").each((_, el) => {
        const attribs = el.attribs;
        if (!attribs) return;
        for (const attrName of Object.keys(attribs)) {
            if (attrName.startsWith("data-sveltekit-")) {
                detected = true;
                evidence = `${attrName} :: ${attribs[attrName]}`;
            }
        }
    });

    // Astro+Svelte: astro-island elements whose renderer-url contains ".svelte."
    // or whose opts attribute contains "value":"svelte"
    $("astro-island").each((_, el) => {
        const attribs = el.attribs;
        if (!attribs) return;
        const rendererUrl: string = attribs["renderer-url"] || "";
        if (rendererUrl.includes(".svelte.") || rendererUrl.includes("/svelte")) {
            detected = true;
            evidence = `astro-island renderer-url :: ${rendererUrl}`;
            return false; // break
        }
        const opts: string = attribs["opts"] || "";
        if (opts.includes('"value":"svelte"') || opts.includes("'value':'svelte'")) {
            detected = true;
            evidence = `astro-island opts :: ${opts.slice(0, 80)}`;
            return false;
        }
    });

    return { detected, evidence };
};
