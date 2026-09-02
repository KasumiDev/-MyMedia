import js from "@eslint/js";
import betterTailwindcss from "eslint-plugin-better-tailwindcss";
import vue from "eslint-plugin-vue";
import vueParser from "vue-eslint-parser";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  { ignores: [".output/**", ".wxt/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs["flat/recommended"],
  betterTailwindcss.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts,vue}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        FileSystemDirectoryHandle: "readonly",
        FileSystemWritableFileStream: "readonly"
      }
    }
  },
  {
    files: ["**/*.vue"],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: [".vue"],
        sourceType: "module"
      }
    },
    settings: {
      "better-tailwindcss": {
        entryPoint: "src/ui/tailwind.css",
        tsconfig: "tsconfig.json"
      }
    }
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "vue/multi-word-component-names": "off"
    }
  }
];
