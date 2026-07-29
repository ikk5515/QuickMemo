export function resolveProductionStagedFeatureFlag(
  configuredValue: unknown,
  productionDefault: boolean,
  isProduction: boolean
) {
  // A staged OFF source commit is a hard Production lock. This prevents an
  // older Vercel environment override from bypassing the reviewed rollout.
  if (isProduction && productionDefault !== true) {
    return false;
  }
  if (configuredValue === true || configuredValue === "true") {
    return true;
  }
  if (configuredValue === false || configuredValue === "false") {
    return false;
  }
  return isProduction ? productionDefault : true;
}
