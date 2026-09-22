const path = require("node:path");
const { container } = require("webpack");

module.exports = {
  entry: {},
  output: {
    path: path.resolve(__dirname, "dist"),
    publicPath: "auto",
    uniqueName: "datahubAgentMFE",
    clean: true,
  },
  plugins: [
    new container.ModuleFederationPlugin({
      name: "datahubAgentMFE",
      filename: "remoteEntry.js",
      exposes: { "./mount": "./mount.js" },
    }),
  ],
};
