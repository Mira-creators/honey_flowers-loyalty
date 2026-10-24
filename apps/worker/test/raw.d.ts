// Vite `?raw` imports (file contents as a string) used by tests.
declare module '*?raw' {
  const text: string;
  export default text;
}
