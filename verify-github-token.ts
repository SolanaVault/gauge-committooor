import { readFile } from "node:fs/promises";

import { saveDataToGitHub } from "./github.ts";

const content = await readFile("last_parsed_epoch", "utf8");
await saveDataToGitHub([{ path: "last_parsed_epoch", content }]);
