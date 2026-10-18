// Prints the live-check results as GitHub workflow annotations so they are visible
// on the run page (and via the API) without opening raw logs.
import { existsSync, readFileSync } from "node:fs";

const path = process.argv[2] ?? "live-report.json";
const flat = (text) => String(text).replace(/\r?\n/g, " ").replace(/%/g, "%25");

if (!existsSync(path)) {
  console.log("::error title=live-base::no report written, the live test crashed before reporting");
} else {
  const report = JSON.parse(readFileSync(path, "utf8"));
  for (const check of report.checks) {
    const level = check.ok ? "notice" : "error";
    console.log(`::${level} title=live-base::${check.ok ? "PASS" : "FAIL"} - ${flat(check.name)} ${flat(check.detail)}`);
  }
  const failed = report.checks.filter((c) => !c.ok).length;
  console.log(`::notice title=live-base::${report.checks.length - failed} passed, ${failed} failed`);
}
