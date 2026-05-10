const fs = require('fs');
let code = fs.readFileSync('web/src/pages/SoulPage.tsx', 'utf8');

code = code.replace(/<section style={{ marginBottom: 32 }}>\s*<h3 style={{ marginTop: 0, marginBottom: 12 }}>人格配置<\/h3>/g, 
`<section className="settings-section settings-general-panel" style={{ marginBottom: 32 }}>
          <div className="settings-general-panel-header">
            <div className="settings-section-kicker">人格配置</div>
            <p className="settings-general-panel-copy">
              定义 AI 的性格、语调和行为准则
            </p>
          </div>
          <div className="settings-subsection">`);

code = code.replace(/<label className="form-field">/g, '<label className="config-field" style={{ display: "flex", flexDirection: "column", gap: 6 }}>');
code = code.replace(/<label\s+className="form-field"\s+style={{ display: 'block', marginTop: 16 }}\s*>/g, '<label className="config-field" style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 16 }}>');
code = code.replace(/<label\s+className="form-field"\s+style={{ display: 'block', marginTop: 12 }}\s*>/g, '<label className="config-field" style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>');
code = code.replace(/<label className="form-field" style={{ flex: 1, minWidth: 200 }}>/g, '<label className="config-field" style={{ flex: 1, minWidth: 200, display: "flex", flexDirection: "column", gap: 6 }}>');
code = code.replace(/<label className="form-field" style={{ width: 100 }}>/g, '<label className="config-field" style={{ width: 100, display: "flex", flexDirection: "column", gap: 6 }}>');
code = code.replace(/<label className="form-field" style={{ width: 80 }}>/g, '<label className="config-field" style={{ width: 80, display: "flex", flexDirection: "column", gap: 6 }}>');

code = code.replace(/<span className="form-label">/g, '<span className="settings-summary-label">');
code = code.replace(/className="form-input"/g, '');

code = code.replace(/<label\s+style={{\s*display: 'flex',\s*alignItems: 'center',\s*gap: 8,\s*marginTop: 12,\s*cursor: 'pointer',\s*}}\s*>/g, '<label className="settings-checkbox-field" style={{ marginTop: 16 }}>');

code = code.replace(/<section>\s*<h3 style={{ marginTop: 0, marginBottom: 12 }}>用户记忆<\/h3>\s*<p\s+style={{ margin: '0 0 12px', opacity: 0.6, fontSize: 13 }}\s*>/g, 
`<section className="settings-section settings-general-panel">
          <div className="settings-general-panel-header">
            <div className="settings-section-kicker">用户记忆</div>
            <p className="settings-general-panel-copy">`);

code = code.replace(/AI 会在对话中参考这些记忆，让回答更个性化\s*<\/p>/g, `AI 会在对话中参考这些记忆，让回答更个性化
            </p>
          </div>
          <div className="settings-subsection">`);

code = code.replace(/<section style={{ marginBottom: 32 }}>\s*<h3 style={{ marginTop: 0, marginBottom: 12 }}>快速选择预设人格<\/h3>/g, 
`<section className="settings-section settings-general-panel" style={{ marginBottom: 32 }}>
          <div className="settings-general-panel-header">
            <div className="settings-section-kicker">快速选择预设人格</div>
            <p className="settings-general-panel-copy">
              选择一个预设模板，快速应用
            </p>
          </div>
          <div className="settings-subsection">`);

code = code.replace(/<\/section>/g, '</div>\n        </section>');

fs.writeFileSync('web/src/pages/SoulPage.tsx', code);
