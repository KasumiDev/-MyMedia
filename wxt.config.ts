import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  modules: ["@wxt-dev/module-vue"],
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: ({ browser }) => ({
    name: "Fansly MyMedia (Feasibility Spike)",
    version: "0.1.0",
    description: "Tests authenticated MyMedia access for the currently signed-in Fansly user.",
    permissions: ["downloads", "storage"],
    host_permissions: ["https://fansly.com/*"],
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
