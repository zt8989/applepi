import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  plugins: [tailwindcss()],
  server: {
    port: 5273,
  },
});
