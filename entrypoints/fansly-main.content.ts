import { installBridge } from "../src/page/bridge";

export default defineContentScript({
  matches: ["https://fansly.com/*"],
  world: "MAIN",
  runAt: "document_start",
  main() {
    installBridge();
  }
});
