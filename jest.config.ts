import type { Config } from "jest";
import nextJest from "next/jest.js";

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files in your test environment
  dir: "./",
});

// Add any custom config to be passed to Jest
const config: Config = {
  coverageProvider: "v8",
  testEnvironment: "jsdom",
  testMatch: ["**/*.test.js", "**/*.test.ts", "**/*.test.jsx", "**/*.test.tsx"],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  // NextChat 是另一个仓库的 submodule，别把它那份过期的测试也算进来
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/NextChat/"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
    // fflate 默认走 ESM，jest 里用它的 CJS 构建
    "^fflate$": "<rootDir>/node_modules/fflate/lib/index.cjs",
  },
  extensionsToTreatAsEsm: [".ts", ".tsx"],
  injectGlobals: true,
};

// createJestConfig is exported this way to ensure that next/jest can load the Next.js config which is async
export default createJestConfig(config);
