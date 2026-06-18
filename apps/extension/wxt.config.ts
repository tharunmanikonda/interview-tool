import { defineConfig } from "wxt";

export default defineConfig({
  manifestVersion: 3,
  dev: {
    server: {
      hostname: "127.0.0.1",
      port: 3000
    }
  },
  runner: {
    disabled: true
  },
  manifest: {
    name: "GPTDisguise Live Assist",
    description: "Google Docs-style live assist overlay for ChatGPT.",
    version: "0.1.0",
    permissions: ["activeTab", "tabCapture", "storage"],
    host_permissions: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
    action: {
      default_title: "GPTDisguise Live Assist"
    }
  }
});
