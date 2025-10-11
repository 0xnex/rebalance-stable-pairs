import { importEvents } from "./src/event_importer";
import path from "path";

const POOL_ID =
  "0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9";
const dataDir = path.join(__dirname, `../mmt_txs/${POOL_ID}`);

await importEvents(POOL_ID, Date.now(), [], { dataDir });
