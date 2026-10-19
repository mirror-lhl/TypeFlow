/**
 * 国际化基础设施。
 *
 * 放在 `shared/` 而不是 `renderer/`：主进程的菜单标签、文件对话框标题
 * 同样需要翻译，两个进程共用一份字符串表可以避免"界面是英文、菜单是中文"
 * 这种割裂（菜单文案散落在两处时极易出现）。
 *
 * 设计取舍：
 *  - **不做插值语法解析**，用函数式消息：`messages.app.openedFile(name)`。
 *    模板字符串 + 占位符替换需要自己实现解析、转义与参数校验，
 *    而对本项目这种规模的 UI，函数式更短、有类型检查、且支持复数等复杂形态。
 *  - **缺失键回退到中文**：中文是源语言，任何遗漏都至少能显示原文而不是键名。
 */

export type Locale = 'zh-CN' | 'en-US'

export const SUPPORTED_LOCALES: Locale[] = ['zh-CN', 'en-US']

export const LOCALE_LABELS: Record<Locale, string> = {
  'zh-CN': '简体中文',
  'en-US': 'English'
}

export const DEFAULT_LOCALE: Locale = 'zh-CN'

/** 把任意 BCP-47 标签归一到受支持的 locale。 */
export function normalizeLocale(tag: string | null | undefined): Locale {
  if (!tag) return DEFAULT_LOCALE
  const lower = tag.toLowerCase()
  if (lower.startsWith('zh')) return 'zh-CN'
  // 海外上架：未支持的系统语言（日/德/法等）回退英文，
  // 而不是默认中文——否则非目标地区用户打开就是中文界面
  return 'en-US'
}

/* ------------------------------------------------------------------ *
 * 字符串表
 * ------------------------------------------------------------------ */

export interface Messages {
  app: {
    name: string
    untitled: string
  }
  menu: {
    file: string
    edit: string
    view: string
    window: string
    help: string
    new: string
    open: string
    openFolder: string
    recent: string
    recentEmpty: string
    clearRecent: string
    save: string
    saveAs: string
    exportHtml: string
    exportPdf: string
    closeTab: string
    closeWindow: string
    quit: string
    undo: string
    redo: string
    cut: string
    copy: string
    paste: string
    selectAll: string
    insertTable: string
    find: string
    findInFiles: string
    toggleSidebar: string
    toggleTheme: string
    themeVariant: string
    themeImport: string
    themeClear: string
    language: string
    refreshWorkspace: string
    toggleMode: string
    toggleLayout: string
    resetZoom: string
    zoomIn: string
    zoomOut: string
    fullscreen: string
    devTools: string
    about: string
    markdownReference: string
    openConfigDirectory: string
    checkForUpdates: string
    resetUi: string
    services: string
    hide: string
    hideOthers: string
    unhide: string
  }
  toolbar: {
    files: string
    outline: string
    search: string
    new: string
    open: string
    save: string
    openFolder: string
    toggleSidebar: string
    source: string
    wysiwyg: string
    hidePreview: string
    showPreview: string
    restoreSplit: string
    lightDark: string
    importTheme: string
    exportHtml: string
    exportPdf: string
    insertTable: string
    addRowAfter: string
    addColumnAfter: string
    deleteRow: string
    deleteColumn: string
    deleteTable: string
    addRowAfterShort: string
    addColumnAfterShort: string
    deleteRowShort: string
    deleteColumnShort: string
    deleteTableShort: string
    heading1: string
    heading2: string
    heading3: string
    bold: string
    italic: string
    inlineCode: string
    strikethrough: string
    bulletList: string
    orderedList: string
    blockquote: string
    cycleThemeVariant: string
    previousMatch: string
    nextMatch: string
    close: string
  }
  panel: {
    noWorkspace: string
    noWorkspaceHint: string
    noHeadings: string
    searchPlaceholder: string
    caseSensitive: string
    searching: string
    noResults: string
    /** 大纲里标题为空时的占位文案 */
    emptyHeading: string
    /** 新建文件/文件夹的默认名 */
    newFileName: string
    newFolderName: string
    matchCount: string
    fileCount: string
    showingFirst: string
    limitReached: string
  }
  status: {
    ready: string
    openedFile: string
    saved: string
    savedAs: string
    newDocument: string
    deleted: string
    renamed: string
    tabs: string
    /** 单数形式；英文需要区分 1 tab / 2 tabs */
    tab: string
    stats: string
    statsWords: string
    statsLines: string
    imageLoading: string
    workspaceIs: string
    refreshed: string
    canceled: string
    generatingPdf: string
    exported: string
    exportMissingImages: string
    customThemeApplied: string
    customThemeCleared: string
    uiReset: string
    themeVariantIs: string
    readOnlyEncoding: string
    encodingGuessed: string
    workspaceTooLarge: string
    updateStatus: string
    imageInserted: string
    imageInsertedSuffix: string
    imagePartialFailure: string
    fileDeletedSuffix: string
    plainTextSourceOnly: string
    viewerReadOnly: string
    viewerLoading: string
    viewerPages: string
    viewerSanitized: string
  }
  themeVariant: {
    default: string
    serif: string
    compact: string
  }
  dialog: {
    openDocument: string
    openableFilter: string
    markdownFilter: string
    textFilter: string
    viewFilter: string
    allFiles: string
    saveAs: string
    chooseWorkspace: string
    chooseThemeCss: string
    grantFolderAccess: string
    grantFolderAccessMessage: string
    confirmDelete: string
    deleteAffectedTabs: string
    unsavedTitle: string
    tabUnsavedToFile: string
    tabCloseDirty: string
    tabClose: string
    unsavedMessage: string
    unsavedDetail: string
    saveButton: string
    discardButton: string
    cancelButton: string
    closeTabUnsaved: string
  }
  error: {
    openFailed: string
    saveFailed: string
    saveAsFailed: string
    openFolderFailed: string
    readTreeFailed: string
    searchFailed: string
    exportHtmlFailed: string
    exportPdfFailed: string
    importThemeFailed: string
    insertImageFailed: string
    imageNeedsSavedDocument: string
    documentTooLarge: string
    pathOutsideWorkspace: string
    cannotDeleteRoot: string
    unsupportedImageFormat: string
    imageTooLarge: string
    assetPathInvalid: string
    assetPathMustBeAbsolute: string
    assetContentEmpty: string
    sandboxAccessLost: string
    sandboxFolderNeeded: string
    unsupportedDocument: string
    nameContainsSeparator: string
    imageMissing: string
    imageCannotDisplay: string
    viewerFailed: string
  }
  placeholder: {
    editor: string
  }
}

const zhCN: Messages = {
  app: { name: 'TypeFlow', untitled: '未命名' },
  menu: {
    file: '文件',
    edit: '编辑',
    view: '视图',
    window: '窗口',
    help: '帮助',
    new: '新建',
    open: '打开…',
    openFolder: '打开文件夹…',
    recent: '最近打开',
    recentEmpty: '（暂无）',
    clearRecent: '清除最近记录',
    save: '保存',
    saveAs: '另存为…',
    exportHtml: '导出为 HTML…',
    exportPdf: '导出为 PDF…',
    closeTab: '关闭标签页',
    closeWindow: '关闭窗口',
    quit: '退出',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选',
    insertTable: '插入表格',
    find: '在文档中查找',
    findInFiles: '在工作区中搜索',
    toggleSidebar: '显示/隐藏侧边栏',
    toggleTheme: '切换明暗',
    themeVariant: '切换排版主题',
    themeImport: '导入自定义主题 CSS…',
    themeClear: '清除自定义主题',
    language: '切换界面语言',
    refreshWorkspace: '刷新工作区文件树',
    toggleMode: '切换所见即所得 / 源码',
    toggleLayout: '切换布局',
    resetZoom: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    fullscreen: '全屏',
    devTools: '开发者工具',
    about: '关于 TypeFlow',
    markdownReference: 'Markdown 语法参考',
    openConfigDirectory: '打开配置目录',
    checkForUpdates: '检查更新…',
    resetUi: '重置界面设置…',
    services: '服务',
    hide: '隐藏 TypeFlow',
    hideOthers: '隐藏其他',
    unhide: '全部显示'
  },
  toolbar: {
    files: '文件',
    outline: '大纲',
    search: '搜索',
    new: '新建',
    open: '打开',
    save: '保存',
    openFolder: '文件夹',
    toggleSidebar: '显示/隐藏侧边栏',
    source: '源码',
    wysiwyg: '所见即所得',
    hidePreview: '隐藏显示区（仅保留编辑区）',
    showPreview: '恢复显示区（编辑 + 显示）',
    restoreSplit: '恢复分屏（编辑 + 显示）',
    lightDark: '明暗',
    importTheme: '导入主题',
    exportHtml: 'HTML',
    exportPdf: 'PDF',
    insertTable: '插入表格',
    addRowAfter: '在下方插入行',
    addColumnAfter: '在右侧插入列',
    deleteRow: '删除当前行',
    deleteColumn: '删除当前列',
    deleteTable: '删除整张表格',
    addRowAfterShort: '+行',
    addColumnAfterShort: '+列',
    deleteRowShort: '−行',
    deleteColumnShort: '−列',
    deleteTableShort: '✕表',
    heading1: '一级标题 (⌥⌘1)',
    heading2: '二级标题 (⌥⌘2)',
    heading3: '三级标题 (⌥⌘3)',
    bold: '加粗 (⌘B)',
    italic: '斜体 (⌘I)',
    inlineCode: '行内代码 (⌘E)',
    strikethrough: '删除线 (⇧⌘X)',
    bulletList: '无序列表',
    orderedList: '有序列表',
    blockquote: '引用',
    cycleThemeVariant: '切换排版主题 (⌥⌘L)',
    previousMatch: '上一个 (⇧↩)',
    nextMatch: '下一个 (↩)',
    close: '关闭 (Esc)',
  },
  panel: {
    noWorkspace: '未打开文件夹',
    noWorkspaceHint: '按 ⇧⌘O 选择要浏览的文件夹',
    noHeadings: '当前文档没有标题',
    searchPlaceholder: '在工作区中搜索…',
    caseSensitive: '区分大小写',
    searching: '搜索中…',
    noResults: '未找到结果',
    emptyHeading: '(空标题)',
    newFileName: '未命名.md',
    newFolderName: '新建文件夹',
    matchCount: '处匹配',
    fileCount: '个文件',
    showingFirst: '显示前',
    limitReached: '（已达上限，结果可能不完整）'
  },
  status: {
    ready: '就绪',
    openedFile: '已打开',
    saved: '已保存',
    savedAs: '已另存为',
    newDocument: '新建文档',
    deleted: '已删除',
    renamed: '已重命名为',
    tabs: '个标签',
    tab: '个标签',
    stats: '字',
    statsWords: '词',
    statsLines: '行',
    imageLoading: '加载中',
    workspaceIs: '工作区：',
    refreshed: '已刷新文件树',
    canceled: '已取消',
    generatingPdf: '正在生成 PDF…',
    exported: '已导出',
    exportMissingImages: '张图片缺失',
    customThemeApplied: '已应用自定义主题：',
    customThemeCleared: '已恢复内置主题',
    uiReset: '界面设置已重置',
    themeVariantIs: '排版主题：',
    readOnlyEncoding: '无法安全回写，已按',
    encodingGuessed: '编码为推测结果，保存前请核对',
    workspaceTooLarge: '文件树过大，仅显示部分内容',
    updateStatus: '更新',
    imageInserted: '已插入',
    imageInsertedSuffix: '张图片到 assets/',
    imagePartialFailure: '部分图片插入失败',
    fileDeletedSuffix: '（文件已删除）',
    plainTextSourceOnly: '纯文本文档以源码模式编辑，内容逐字保存',
    viewerReadOnly: '当前文件仅供查看，不支持编辑',
    viewerLoading: '正在载入…',
    viewerPages: '页',
    viewerSanitized: '已忽略不支持或可能不安全的元素'
  },
  themeVariant: {
    default: '默认',
    serif: '衬线阅读',
    compact: '紧凑'
  },
  dialog: {
    openDocument: '打开文档',
    openableFilter: '支持的文件',
    markdownFilter: 'Markdown',
    textFilter: '纯文本',
    viewFilter: 'PDF / HTML / 图片',
    allFiles: '全部文件',
    saveAs: '另存为',
    chooseWorkspace: '选择工作区文件夹',
    chooseThemeCss: '选择自定义主题 CSS',
    grantFolderAccess: '授权文件夹访问',
    grantFolderAccessMessage: 'App Store 沙箱要求显式授权：请选择文档所在文件夹，允许 TypeFlow 保存文件与写入图片',
    confirmDelete: '确定删除',
    deleteAffectedTabs: '个已打开的标签引用了它（内容会保留为未保存状态）',
    unsavedTitle: '未保存的修改',
    tabUnsavedToFile: '（未保存到文件）',
    tabCloseDirty: '关闭（有未保存修改）',
    tabClose: '关闭',
    unsavedMessage: '当前文档有未保存的修改。',
    unsavedDetail: '关闭前是否保存？',
    saveButton: '保存',
    discardButton: '不保存',
    cancelButton: '取消',
    closeTabUnsaved: '有未保存的修改。点击「确定」保存后关闭，「取消」放弃修改。'
  },
  error: {
    openFailed: '打开失败',
    saveFailed: '保存失败',
    saveAsFailed: '另存为失败',
    openFolderFailed: '打开文件夹失败',
    readTreeFailed: '读取文件树失败',
    searchFailed: '搜索失败',
    exportHtmlFailed: '导出 HTML 失败',
    exportPdfFailed: '导出 PDF 失败',
    importThemeFailed: '导入主题失败',
    insertImageFailed: '插入图片失败',
    imageNeedsSavedDocument: '请先保存文档，图片会存放在文档同目录的 assets/ 下',
    documentTooLarge: '文档过大',
    pathOutsideWorkspace: '目标路径不在当前工作区内',
    cannotDeleteRoot: '不能删除工作区根目录',
    unsupportedImageFormat: '不支持的图片格式',
    imageTooLarge: '图片过大，上限 32 MB',
    assetPathInvalid: '资源路径不合法',
    assetPathMustBeAbsolute: '资源路径必须是绝对路径',
    assetContentEmpty: '资源内容为空',
    sandboxAccessLost: '沙箱授权已失效或不足，请通过系统对话框重新选择该文件或文件夹以恢复访问',
    sandboxFolderNeeded: '写入图片需要授权文档所在文件夹，请在系统对话框中选择该文件夹',
    unsupportedDocument: '不是可打开的文件（支持 Markdown、.txt、PDF、HTML 与图片）',
    nameContainsSeparator: '名称不能包含路径分隔符',
    imageMissing: '图片缺失',
    imageCannotDisplay: '图片无法显示',
    viewerFailed: '无法显示该文件'
  },
  placeholder: {
    editor: '开始写作，或用 ⌘O 打开 Markdown / txt 文件…'
  }
}

const enUS: Messages = {
  app: { name: 'TypeFlow', untitled: 'Untitled' },
  menu: {
    file: 'File',
    edit: 'Edit',
    view: 'View',
    window: 'Window',
    help: 'Help',
    new: 'New',
    open: 'Open…',
    openFolder: 'Open Folder…',
    recent: 'Open Recent',
    recentEmpty: '(none)',
    clearRecent: 'Clear Recent',
    save: 'Save',
    saveAs: 'Save As…',
    exportHtml: 'Export as HTML…',
    exportPdf: 'Export as PDF…',
    closeTab: 'Close Tab',
    closeWindow: 'Close Window',
    quit: 'Quit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    insertTable: 'Insert Table',
    find: 'Find in Document',
    findInFiles: 'Search in Workspace',
    toggleSidebar: 'Toggle Sidebar',
    toggleTheme: 'Toggle Light/Dark',
    themeVariant: 'Cycle Typography Theme',
    themeImport: 'Import Custom Theme CSS…',
    themeClear: 'Clear Custom Theme',
    language: 'Switch Language',
    refreshWorkspace: 'Refresh File Tree',
    toggleMode: 'Toggle WYSIWYG / Source',
    toggleLayout: 'Cycle Layout',
    resetZoom: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    fullscreen: 'Toggle Full Screen',
    devTools: 'Developer Tools',
    about: 'About TypeFlow',
    markdownReference: 'Markdown Reference',
    openConfigDirectory: 'Open Config Directory',
    checkForUpdates: 'Check for Updates…',
    resetUi: 'Reset Interface Settings…',
    services: 'Services',
    hide: 'Hide TypeFlow',
    hideOthers: 'Hide Others',
    unhide: 'Show All'
  },
  toolbar: {
    files: 'Files',
    outline: 'Outline',
    search: 'Search',
    new: 'New',
    open: 'Open',
    save: 'Save',
    openFolder: 'Folder',
    toggleSidebar: 'Toggle sidebar',
    source: 'Source',
    wysiwyg: 'WYSIWYG',
    hidePreview: 'Hide preview pane',
    showPreview: 'Show preview pane',
    restoreSplit: 'Restore split view (editor + preview)',
    lightDark: 'Theme',
    importTheme: 'Import theme',
    exportHtml: 'HTML',
    exportPdf: 'PDF',
    insertTable: 'Insert table',
    addRowAfter: 'Insert row below',
    addColumnAfter: 'Insert column right',
    deleteRow: 'Delete row',
    deleteColumn: 'Delete column',
    deleteTable: 'Delete table',
    addRowAfterShort: '+row',
    addColumnAfterShort: '+col',
    deleteRowShort: '−row',
    deleteColumnShort: '−col',
    deleteTableShort: '✕tbl',
    heading1: 'Heading 1 (⌥⌘1)',
    heading2: 'Heading 2 (⌥⌘2)',
    heading3: 'Heading 3 (⌥⌘3)',
    bold: 'Bold (⌘B)',
    italic: 'Italic (⌘I)',
    inlineCode: 'Inline code (⌘E)',
    strikethrough: 'Strikethrough (⇧⌘X)',
    bulletList: 'Bullet list',
    orderedList: 'Numbered list',
    blockquote: 'Blockquote',
    cycleThemeVariant: 'Cycle typography theme (⌥⌘L)',
    previousMatch: 'Previous match (⇧↩)',
    nextMatch: 'Next match (↩)',
    close: 'Close (Esc)',
  },
  panel: {
    noWorkspace: 'No folder opened',
    noWorkspaceHint: 'Press ⇧⌘O to choose a folder',
    noHeadings: 'This document has no headings',
    searchPlaceholder: 'Search in workspace…',
    caseSensitive: 'Match case',
    searching: 'Searching…',
    noResults: 'No results',
    emptyHeading: '(untitled heading)',
    newFileName: 'Untitled.md',
    newFolderName: 'New folder',
    matchCount: 'matches',
    fileCount: 'files',
    showingFirst: 'Showing first',
    limitReached: ' (limit reached, results may be incomplete)'
  },
  status: {
    ready: 'Ready',
    openedFile: 'Opened',
    saved: 'Saved',
    savedAs: 'Saved as',
    newDocument: 'New document',
    deleted: 'Deleted',
    renamed: 'Renamed to',
    tabs: 'tabs',
    tab: 'tab',
    stats: 'chars',
    statsWords: 'words',
    statsLines: 'lines',
    imageLoading: 'Loading',
    workspaceIs: 'Workspace: ',
    refreshed: 'File tree refreshed',
    canceled: 'Canceled',
    generatingPdf: 'Generating PDF…',
    exported: 'Exported',
    exportMissingImages: 'image(s) missing',
    customThemeApplied: 'Custom theme applied: ',
    customThemeCleared: 'Reverted to built-in theme',
    uiReset: 'Interface settings reset',
    themeVariantIs: 'Typography theme: ',
    readOnlyEncoding: 'cannot be written safely, saved as',
    encodingGuessed: 'encoding was guessed — please verify before saving',
    workspaceTooLarge: 'File tree is large; showing partial content',
    updateStatus: 'Update',
    imageInserted: 'Inserted',
    imageInsertedSuffix: ' image(s) into assets/',
    imagePartialFailure: 'Some images failed',
    fileDeletedSuffix: ' (file deleted)',
    plainTextSourceOnly: 'Plain text is edited in source mode; content is saved verbatim',
    viewerReadOnly: 'This file is view-only; editing is not supported',
    viewerLoading: 'Loading…',
    viewerPages: 'pages',
    viewerSanitized: 'Unsupported or potentially unsafe elements were removed'
  },
  themeVariant: {
    default: 'Default',
    serif: 'Serif reading',
    compact: 'Compact'
  },
  dialog: {
    openDocument: 'Open Document',
    openableFilter: 'Supported Files',
    markdownFilter: 'Markdown',
    textFilter: 'Plain Text',
    viewFilter: 'PDF / HTML / Images',
    allFiles: 'All Files',
    saveAs: 'Save As',
    chooseWorkspace: 'Choose Workspace Folder',
    chooseThemeCss: 'Choose Custom Theme CSS',
    grantFolderAccess: 'Grant Folder Access',
    grantFolderAccessMessage: 'The App Store sandbox requires explicit access: choose the folder containing your document so TypeFlow can save files and write images',
    confirmDelete: 'Delete',
    deleteAffectedTabs: 'open tab(s) reference it (content kept as unsaved)',
    unsavedTitle: 'Unsaved Changes',
    tabUnsavedToFile: ' (not saved to a file)',
    tabCloseDirty: 'Close (unsaved changes)',
    tabClose: 'Close',
    unsavedMessage: 'This document has unsaved changes.',
    unsavedDetail: 'Save before closing?',
    saveButton: 'Save',
    discardButton: "Don't Save",
    cancelButton: 'Cancel',
    closeTabUnsaved: 'has unsaved changes. Click OK to save and close, Cancel to discard.'
  },
  error: {
    openFailed: 'Open failed',
    saveFailed: 'Save failed',
    saveAsFailed: 'Save As failed',
    openFolderFailed: 'Opening folder failed',
    readTreeFailed: 'Reading file tree failed',
    searchFailed: 'Search failed',
    exportHtmlFailed: 'HTML export failed',
    exportPdfFailed: 'PDF export failed',
    importThemeFailed: 'Importing theme failed',
    insertImageFailed: 'Inserting image failed',
    imageNeedsSavedDocument: 'Save the document first — images go into assets/ next to it',
    documentTooLarge: 'Document too large',
    pathOutsideWorkspace: 'Target path is outside the current workspace',
    cannotDeleteRoot: 'Cannot delete the workspace root',
    unsupportedImageFormat: 'Unsupported image format',
    imageTooLarge: 'Image too large (limit 32 MB)',
    assetPathInvalid: 'Invalid asset path',
    assetPathMustBeAbsolute: 'Asset path must be absolute',
    assetContentEmpty: 'Asset content is empty',
    sandboxAccessLost: 'Sandbox access expired or insufficient — re-select this file or folder in the system dialog to restore access',
    sandboxFolderNeeded: 'Writing images requires access to the document folder — please grant it in the system dialog',
    unsupportedDocument: 'is not a supported file (Markdown, .txt, PDF, HTML and images are)',
    nameContainsSeparator: 'Name cannot contain path separators',
    imageMissing: 'Image missing',
    imageCannotDisplay: 'Cannot display image',
    viewerFailed: 'Cannot display this file'
  },
  placeholder: {
    editor: 'Start writing, or press ⌘O to open a Markdown or .txt file…'
  }
}

const TABLES: Record<Locale, Messages> = {
  'zh-CN': zhCN,
  'en-US': enUS
}

let currentLocale: Locale = DEFAULT_LOCALE

export function setLocale(locale: Locale): void {
  currentLocale = locale
}

export function getLocale(): Locale {
  return currentLocale
}

/**
 * 取当前语言的字符串表。
 *
 * 返回对象而非键值查找函数，是为了让调用点保持 `messages.status.ready` 这种
 * 结构化的可读形式——改成 `t('status.ready')` 会丢掉编译期检查，
 * 键名拼错只能等到运行时才发现。
 */
export function messages(locale: Locale = currentLocale): Messages {
  return TABLES[locale] ?? TABLES[DEFAULT_LOCALE]
}

/** 占位符替换：仅在确实需要拼接少量变量时使用。 */
export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) =>
    key in values ? String(values[key]) : `{${key}}`
  )
}
