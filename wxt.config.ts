import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  modules: ["@wxt-dev/module-vue"],
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: ({ browser }) => ({
    name: "Fansly MyMedia (Feasibility Spike)",
    version: "0.1.0",
    description: "Tests authenticated MyMedia access for the currently signed-in Fansly user.",
    permissions: ["cookies", "downloads", "nativeMessaging", "storage"],
    host_permissions: [
      "https://fansly.com/*",
      "https://cdn1.fansly.com/*",
      "https://cdn2.fansly.com/*",
      "https://cdn3.fansly.com/*",
      "https://cdn4.fansly.com/*",
      "https://cdn5.fansly.com/*",
      "https://media.fansly.com/*"
    ],
    browser_specific_settings:
      browser === "firefox"
        ? {
            gecko: {
              id: "fansly-mymedia-extension@local",
              data_collection_permissions: {
                required: ["none"]
              }
            }
          }
        : undefined
  })
});
