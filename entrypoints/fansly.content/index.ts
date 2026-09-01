import { createApp } from "vue";
import App from "../../src/ui/App.vue";
import "./style.css";

export default defineContentScript({
  matches: ["https://fansly.com/*"],
  runAt: "document_idle",
  cssInjectionMode: "ui",
  async main(ctx) {
    const ui = await createShadowRootUi(ctx, {
      name: "fansly-mymedia",
      position: "inline",
      anchor: "body",
      onMount(container) {
        const app = createApp(App);
        app.mount(container);
        return app;
      },
      onRemove(app) {
        app?.unmount();
      }
    });
    ui.mount();
  }
});
