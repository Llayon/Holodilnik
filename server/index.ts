import { app } from "./app.js";
import { config, logConfig } from "./config.js";

const port = config.port;
app.listen(port, () => {
  logConfig();
  console.log(`[server] listening on http://localhost:${port}`);
});

export default app;
