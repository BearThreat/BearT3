import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vite-plus/test";

import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REHYPE_PLUGINS_WITH_RAW_HTML,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  orderedListGutterStyle,
  protectCurrencyFromInlineMath,
} from "./ChatMarkdown";

function renderMath(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={CHAT_MARKDOWN_REHYPE_PLUGINS}
    >
      {markdown}
    </ReactMarkdown>,
  );
}

describe("chat markdown math", () => {
  it("renders inline and block math with KaTeX", () => {
    const inline = renderMath("The gain is $G = 1 - C_n / C_b$.");
    const block = renderMath("$$\nG = \\frac{8}{20}\n$$");

    expect(inline).toContain('class="katex"');
    expect(inline).not.toContain("$G = 1");
    expect(block).toContain('class="katex-display"');
    expect(block).not.toContain("$$");
  });

  it("renders numeric prices as currency instead of malformed math", () => {
    const source = "Cost: **$0.4675**. API equivalent: **$2.5877**.";
    const markup = renderMath(protectCurrencyFromInlineMath(source));

    expect(markup).toContain("<strong>$0.4675</strong>");
    expect(markup).toContain("<strong>$2.5877</strong>");
    expect(markup).not.toContain('class="katex"');
  });

  it("keeps genuine numeric equations enabled", () => {
    const markup = renderMath(
      protectCurrencyFromInlineMath("Solve $2x + 1 = 5$, $2 + 2 = 4$, and $2$."),
    );

    expect(markup.match(/class="katex"/g)).toHaveLength(3);
  });

  it("protects common currency forms and leaves code byte-stable", () => {
    const source = [
      "Costs: **$5**, $-5.25, $.50, and $1,234.56/month.",
      "Inline: `$9.99`.",
      "```text",
      "$12.34",
      "```",
    ].join("\n");
    const protectedSource = protectCurrencyFromInlineMath(source);

    expect(protectedSource).toContain("**\\$5**");
    expect(protectedSource).toContain("\\$-5.25");
    expect(protectedSource).toContain("\\$.50");
    expect(protectedSource).toContain("\\$1,234.56/month");
    expect(protectedSource).toContain("`$9.99`");
    expect(protectedSource).toContain("```text\n$12.34\n```");
  });

  it("does not double-escape author-escaped currency", () => {
    expect(protectCurrencyFromInlineMath("Already \\$4.20")).toBe("Already \\$4.20");
  });

  it("keeps raw HTML sanitized while rendering trusted KaTeX output", () => {
    const markup = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS}
        rehypePlugins={CHAT_MARKDOWN_REHYPE_PLUGINS_WITH_RAW_HTML}
      >
        {'<script>alert("unsafe")</script><span onclick="unsafe()">safe</span>\n\n$x^2$'}
      </ReactMarkdown>,
    );

    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("onclick");
    expect(markup).toContain("safe");
    expect(markup).toContain('class="katex"');
  });
});

describe("orderedListGutterStyle", () => {
  it("leaves the default gutter alone for single-digit lists", () => {
    expect(orderedListGutterStyle(9, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for two-digit lists", () => {
    expect(orderedListGutterStyle(99, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for a two-digit list that starts above 1", () => {
    // start=50 + 49 items => last marker is "98", still two digits.
    expect(orderedListGutterStyle(49, 50)).toBeUndefined();
  });

  it("widens the gutter once the last marker reaches three digits", () => {
    // item 100 is the bug from #6512: a 100-item list starting at 1.
    expect(orderedListGutterStyle(100, undefined)).toEqual({ "--list-gutter": "4ch" });
  });

  it("accounts for a non-default start attribute", () => {
    // start=95 + 9 items => last marker is "103", three digits.
    expect(orderedListGutterStyle(9, 95)).toEqual({ "--list-gutter": "4ch" });
  });

  it("scales further for four-digit markers", () => {
    expect(orderedListGutterStyle(1000, undefined)).toEqual({ "--list-gutter": "5ch" });
  });

  it("treats a missing/zero item count as a single item", () => {
    expect(orderedListGutterStyle(0, undefined)).toBeUndefined();
  });
});
