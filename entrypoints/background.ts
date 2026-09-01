import { installServiceWorker } from "../src/background/service-worker";

export default defineBackground(() => {
  installServiceWorker();
});
