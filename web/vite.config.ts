import { defineConfig } from "vitest/config"; import react from "@vitejs/plugin-react"; import { resolve } from "node:path";
export default defineConfig({root:resolve(__dirname),plugins:[react()],build:{outDir:"dist",emptyOutDir:true},server:{port:5173,proxy:{"/api":"http://127.0.0.1:4310","/health":"http://127.0.0.1:4310"}},test:{environment:"jsdom",include:["src/**/*.test.tsx"]}});
