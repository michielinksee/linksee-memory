module.exports = {
  apps: [
    {
      name: 'linksee-memory-http',
      script: 'dist/mcp/http-server.js',
      cwd: 'C:/Users/hassy/project/linksee-memory',
      interpreter: 'node',
      env: {
        LINKSEE_HTTP_PORT: '8300',
      },
    },
  ],
};
