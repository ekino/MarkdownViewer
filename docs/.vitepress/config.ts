import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Markdown Viewer",
  description: "Native macOS markdown documentation viewer",
  base: "/MarkdownViewer/",
  themeConfig: {
    logo: "/ekino-logo.png",
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Reference", link: "/reference/markdown-support" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting Started", link: "/guide/getting-started" },
          { text: "Features", link: "/guide/features" },
          { text: "Auto-updates", link: "/guide/auto-updates" },
          { text: "Security", link: "/guide/security" },
        ],
      },
      {
        text: "Maintainers",
        items: [
          { text: "Releasing & Signing", link: "/maintainers/releasing" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Markdown Support", link: "/reference/markdown-support" },
          {
            text: "Keyboard Shortcuts",
            link: "/reference/keyboard-shortcuts",
          },
        ],
      },
      {
        text: "Contributing",
        link: "/contributing",
      },
    ],
    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/ekino/MarkdownViewer",
      },
    ],
    footer: {
      message:
        '<a href="https://www.ekino.fr" target="_blank" rel="noopener"><img src="/MarkdownViewer/ekino-logo.png" alt="ekino" class="footer-logo"></a>',
      copyright: "Built by ekino",
    },
  },
});
