/**
 * IPC 通道名集中定义。
 * 收敛成常量表而非散落字符串，是防止通道名拼写漂移的最低成本手段。
 */
export const CHANNELS = {
  fileRead: 'file:read',
  fileWrite: 'file:write',
  fileOpenDialog: 'file:open-dialog',
  fileSaveAsDialog: 'file:save-as-dialog',

  prefsGet: 'prefs:get',
  prefsAddRecent: 'prefs:add-recent',
  prefsClearRecent: 'prefs:clear-recent',
  prefsRememberDirectory: 'prefs:remember-directory',
  prefsSetLocale: 'prefs:set-locale',

  updateGetState: 'update:get-state',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateStateChanged: 'update:state-changed',

  exportHtml: 'export:html',
  exportPdf: 'export:pdf',
  themeChooseCss: 'theme:choose-css',
  themeReadCss: 'theme:read-css',

  assetsRead: 'assets:read',
  assetsWrite: 'assets:write',
  assetsResolve: 'assets:resolve',

  viewerReadPdfResource: 'viewer:read-pdf-resource',
  viewerPdfWasmUrl: 'viewer:pdf-wasm-url',

  workspaceChooseDirectory: 'workspace:choose-directory',
  workspaceReadTree: 'workspace:read-tree',
  workspaceCreateFile: 'workspace:create-file',
  workspaceCreateDirectory: 'workspace:create-directory',
  workspaceRename: 'workspace:rename',
  workspaceRemove: 'workspace:remove',
  workspaceSearch: 'workspace:search',
  workspaceWatch: 'workspace:watch',
  workspaceUnwatch: 'workspace:unwatch',
  workspaceChanged: 'workspace:changed',

  windowDocumentEdited: 'window:document-edited',
  windowRepresentedFilename: 'window:represented-filename',
  windowDirtyChange: 'window:dirty-change',
  windowCloseAfterSave: 'window:close-after-save',

  menuCommand: 'menu:command',
  menuOpenPath: 'menu:open-path',
  prefsChanged: 'prefs:changed',

  smokeRendererReady: 'app:smoke-renderer-ready',
  smokeMenuLabels: 'app:smoke-menu-labels',
  smokeTestDone: 'app:smoke-test-done',
  screenshotReady: 'app:screenshot-ready',

  shellOpenExternal: 'shell:open-external'
} as const

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS]
