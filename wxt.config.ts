import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-vue"],
  manifest: {
    name: "Fansly MyMedia (Feasibility Spike)",
    version: "0.1.0",
    description: "Tests authenticated MyMedia access for the currently signed-in Fansly user.",
    permissions: ["downloads", "storage"],
    host_permissions: ["https://fansly.com/*"]
  }
});
