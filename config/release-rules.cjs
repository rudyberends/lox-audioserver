const { execSync } = require("node:child_process");

const BASE_VERSION = "4.0.0";
const BETA_TAG_PATTERN = `v${BASE_VERSION}-beta.*`;

function isBetaBranch() {
  return (
    process.env.GITHUB_REF_NAME === "beta" ||
    process.env.GITHUB_REF === "refs/heads/beta"
  );
}

function hasInitialBetaTag() {
  try {
    const tags = execSync(`git tag --list "${BETA_TAG_PATTERN}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    return tags.length > 0;
  } catch {
    return false;
  }
}

const baseRules = [{ type: "major", release: "major" }];

if (isBetaBranch() && !hasInitialBetaTag()) {
  module.exports = [{ release: "major" }, ...baseRules];
} else {
  module.exports = baseRules;
}
