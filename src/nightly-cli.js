// Run the nightly job once, from cron / a systemd timer / a GitHub Action:
//   npm run nightly            # import + pre-select tomorrow
//   npm run nightly -- 8       # import 8 per category
//   npm run nightly -- 0       # skip the import, only pre-select
//
// A per-category count of 0 disables the import step.

import { runNightly } from './nightly.js';

const perCategory = process.argv[2] === undefined ? 5 : Number(process.argv[2]);
const doImport = Number.isFinite(perCategory) && perCategory > 0;

runNightly({
  doImport,
  perCategory: doImport ? perCategory : 5,
  log: (m) => console.log(`[nightly] ${m}`),
})
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[nightly] fatal: ${err.message}`);
    process.exit(1);
  });
