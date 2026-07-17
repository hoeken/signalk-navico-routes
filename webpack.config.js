const path = require('path');
const { ModuleFederationPlugin } = require('webpack').container;
const packageJson = require('./package.json');

// The SignalK admin UI loads /<plugin-id>/remoteEntry.js as a webpack federated
// module named after the package (with -, @ and / replaced by _) and renders
// its ./PluginConfigurationPanel export instead of the schema-generated form.
// react/react-dom are shared singletons provided by the admin UI (React 19).
const federatedName = packageJson.name.replace(/[-@/]/g, '_');

module.exports = {
  entry: './configpanel/index.ts',
  mode: 'production',
  devtool: 'source-map',
  output: {
    path: path.resolve(__dirname, 'public'),
    filename: 'configpanel.js',
    chunkFilename: 'configpanel.[id].js',
    clean: false,
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: 'ts-loader',
        exclude: /node_modules/,
        options: { configFile: path.resolve(__dirname, 'configpanel/tsconfig.json') },
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js'],
  },
  plugins: [
    new ModuleFederationPlugin({
      name: federatedName,
      library: { type: 'var', name: federatedName },
      filename: 'remoteEntry.js',
      exposes: {
        './PluginConfigurationPanel': './configpanel/PluginConfigurationPanel',
      },
      shared: {
        react: { singleton: true, requiredVersion: '^19' },
        'react-dom': { singleton: true, requiredVersion: '^19' },
      },
    }),
  ],
};
