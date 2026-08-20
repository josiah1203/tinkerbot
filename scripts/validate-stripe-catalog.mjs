#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// npm/pnpm may preserve the conventional `--` separator in argv. Select the
// first positional path after it instead of silently falling back to an empty
// STRIPE_PLANS_JSON value.
const fileArg = process.argv.slice(2).find((argument) => !argument.startsWith("-"));
const raw = fileArg
  ? fs.readFileSync(path.resolve(process.cwd(), fileArg), "utf8")
  : process.env.STRIPE_PLANS_JSON ?? "";

let validateStripePlans;
try {
  ({ validateStripePlans } = await import(path.join(root, "dist/packages/hosted-integrations/src/index.js")));
} catch {
  console.error("Stripe catalog validator requires the TypeScript build. Run `pnpm build` first.");
  process.exitCode = 2;
}

if (validateStripePlans) {
  const result = validateStripePlans(raw, { requireAllPlans: true, requireAnnualPrices: true });
  const output = {
    valid: result.valid,
    planCount: result.plans.length,
    catalogVersion: result.plans[0]?.catalogVersion ?? null,
    plans: result.plans.map((plan) => ({ id: plan.id, monthlyPriceId: plan.monthlyPriceId, annualPriceId: plan.annualPriceId ?? null })),
    errors: result.errors,
  };
  console.log(JSON.stringify(output, null, 2));
  if (!result.valid) process.exitCode = 1;
}
