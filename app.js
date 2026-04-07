// 版本维护 Checklistver 应用
class VersionMaintenanceApp {
    constructor() {
        this.currentDay = 4;
        this.selectedVersionId = null;
        this.fileSystemHandle = null;
        this.data = null; // 初始化时为null，在异步初始化后填充
        this.expandedSubtasks = {};
        this.isInitialized = false;

        this.initElements();
        this.bindEvents();
        this.initFileSystem();
    }

    async initFileSystem() {
        // Step 1: 先从 localStorage 读取（秒开，无弹窗）
        const cached = localStorage.getItem('versionMaintenanceData');
        if (cached) {
            try {
                this.data = this.migrateData(JSON.parse(cached));
                this.isInitialized = true;
                this.render();
            } catch (e) {
                console.error('localStorage 数据损坏:', e);
            }
        }

        // Step 2: 后台尝试从 JSON 文件同步/加载
        await this.syncFromFile();

        // Step 3: 如果本地没有任何数据，才弹窗让用户选择文件夹
        if (!this.data && !localStorage.getItem('versionMaintenanceData')) {
            const db = await this.openDB();
            const handle = await this.getStoredHandle(db);
            if (!handle) {
                this.showFolderSelectModal();
            }
            // 有 handle 但没有 localStorage 数据时，尝试用它加载
            if (handle && !this.isInitialized) {
                this.fileSystemHandle = handle;
                const loaded = await this.loadDataFromFile(false);
                if (!loaded) {
                    try {
                        const result = await handle.requestPermission({ mode: 'readwrite' });
                        if (result === 'granted') {
                            await this.loadDataFromFile(true);
                        } else {
                            this.showFolderSelectModal();
                        }
                    } catch (e) {
                        this.showFolderSelectModal();
                    }
                }
            }
        }

        if (this.isInitialized) {
            this.render();
        }
    }

    async syncFromFile() {
        try {
            const db = await this.openDB();
            const handle = await this.getStoredHandle(db);
            if (!handle) return;

            this.fileSystemHandle = handle;
            // false = 不在文件不存在时创建空数据，避免覆盖 localStorage
            const loaded = await this.loadDataFromFile(false);

            if (loaded && this.data) {
                // 用 JSON 文件数据更新 localStorage 缓存
                localStorage.setItem('versionMaintenanceData', JSON.stringify(this.data));
            }
        } catch (error) {
            // 文件同步失败没关系，localStorage 数据仍在
            console.log('后台文件同步失败（不影响使用）:', error.message);
        }
    }

    openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('VersionMaintenanceApp', 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('handles')) {
                    db.createObjectStore('handles');
                }
            };
        });
    }

    getStoredHandle(db) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction('handles', 'readonly');
            const store = transaction.objectStore('handles');
            const request = store.get('folderHandle');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result || null);
        });
    }

    storeHandle(db, handle) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction('handles', 'readwrite');
            const store = transaction.objectStore('handles');
            const request = store.put(handle, 'folderHandle');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    async selectFolder() {
        try {
            // 如果已有句柄，使用它作为起始位置，这样文件选择器会打开到之前选择的目录
            const options = { mode: 'readwrite' };
            if (this.fileSystemHandle) {
                options.startIn = this.fileSystemHandle;
            }
            const handle = await window.showDirectoryPicker(options);
            this.fileSystemHandle = handle;

            // 保存句柄到 IndexedDB
            const db = await this.openDB();
            await this.storeHandle(db, handle);

            // 创建必要的文件夹
            await this.ensureDirectories();

            // 加载数据
            await this.loadDataFromFile();

            this.hideModal();
            this.render();
            this.showToast('数据文件夹已设置');
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('选择文件夹失败:', error);
                this.showToast('选择文件夹失败');
            }
        }
    }

    async ensureDirectories() {
        if (!this.fileSystemHandle) return;

        try {
            await this.fileSystemHandle.getDirectoryHandle('images', { create: true });
        } catch (error) {
            console.error('创建目录失败:', error);
        }
    }

    showFolderSelectModal() {
        this.showModal(`
            <h2>设置数据文件夹</h2>
            <p style="margin: 16px 0; color: #666;">请选择一个文件夹来存储您的数据。数据会同时保存在本地缓存和文件中。</p>
            <div class="modal-actions" style="justify-content: center;">
                <button class="btn btn-primary" onclick="app.selectFolder()">选择文件夹</button>
            </div>
        `);
    }

    async loadDataFromFile(createIfMissing = true) {
        if (!this.fileSystemHandle) return false;

        try {
            const fileHandle = await this.fileSystemHandle.getFileHandle('data.json');
            const file = await fileHandle.getFile();
            const text = await file.text();
            const data = JSON.parse(text);

            // 兼容旧数据格式
            this.data = this.migrateData(data);
            this.isInitialized = true;
            return true;
        } catch (error) {
            if (error.name === 'NotFoundError') {
                // 文件不存在：如果已有数据（从 localStorage 来的）就不覆盖，否则创建默认数据
                if (!this.data && createIfMissing) {
                    this.data = {
                        versions: [],
                        checklists: {},
                        emails: {}
                    };
                    await this.saveDataToFile();
                    this.isInitialized = true;
                    return true;
                }
                return false;
            } else {
                console.error('加载数据失败:', error);
                return false;
            }
        }
    }

    migrateData(data) {
        // 迁移checklist数据
        Object.keys(data.checklists || {}).forEach(key => {
            if (data.checklists[key]) {
                data.checklists[key] = data.checklists[key].map(item => ({
                    ...item,
                    cautions: item.cautions || item.notes || '',
                    notes: item.notes2 || item.notes || '',
                    link: item.link || '',
                    image: item.image || '',
                    subtasks: item.subtasks ? item.subtasks.map(subtask => ({
                        ...subtask,
                        cautions: subtask.cautions || subtask.notes || '',
                        notes: subtask.notes2 || subtask.notes || '',
                        link: subtask.link || '',
                        image: subtask.image || ''
                    })) : []
                }));
            }
        });

        // 迁移versions数据
        data.versions = (data.versions || []).map(version => {
            let links = version.links;
            if (!links && version.link) {
                links = [{title: '链接', url: version.link}];
            } else if (!links) {
                links = [];
            }
            return {
                ...version,
                links,
                status: version.status || 'active',
                manager: version.manager || ''
            };
        });

        return data;
    }

    async saveDataToFile() {
        if (!this.fileSystemHandle) return;

        try {
            const fileHandle = await this.fileSystemHandle.getFileHandle('data.json', { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(JSON.stringify(this.data, null, 2));
            await writable.close();
        } catch (error) {
            console.error('保存数据失败:', error);
        }
    }

    initElements() {
        this.elements = {
            dayBtns: document.querySelectorAll('.day-btn'),
            versionList: document.getElementById('versionList'),
            versionDetail: document.getElementById('versionDetail'),
            addVersionBtn: document.getElementById('addVersionBtn'),
            modal: document.getElementById('modal'),
            modalBody: document.getElementById('modalBody'),
            modalClose: document.querySelector('.modal-close'),
            exportBtn: document.getElementById('exportBtn'),
            importBtn: document.getElementById('importBtn'),
            importFile: document.getElementById('importFile'),
            newWeekBtn: document.getElementById('newWeekBtn')
        };
    }

    bindEvents() {
        this.elements.dayBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                this.currentDay = parseInt(btn.dataset.day);
                this.render();
            });
        });

        this.elements.addVersionBtn.addEventListener('click', () => {
            this.showAddVersionModal();
        });

        this.elements.modalClose.addEventListener('click', () => {
            this.hideModal();
        });

        this.elements.modal.addEventListener('click', (e) => {
            if (e.target === this.elements.modal) {
                this.hideModal();
            }
        });

        this.elements.exportBtn.addEventListener('click', () => {
            this.exportData();
        });

        this.elements.importBtn.addEventListener('click', () => {
            this.elements.importFile.click();
        });

        this.elements.importFile.addEventListener('change', (e) => {
            this.importData(e.target.files[0]);
        });

        this.elements.newWeekBtn.addEventListener('click', () => {
            this.startNewWeek();
        });

        this.elements.showIncompleteBtn = document.getElementById('showIncompleteBtn');
        if (this.elements.showIncompleteBtn) {
            this.elements.showIncompleteBtn.addEventListener('click', () => {
                this.toggleIncompletePanel();
            });
        }

    }

    saveData() {
        // 保存到本地文件和localStorage（作为备份）
        try {
            localStorage.setItem('versionMaintenanceData', JSON.stringify(this.data));
        } catch (e) {
            console.error('localStorage 保存失败:', e);
        }
        this.saveDataToFile();
    }

    render() {
        if (!this.isInitialized || !this.data) {
            // 数据尚未加载，显示加载中
            this.elements.versionDetail.innerHTML = '<p class="placeholder">正在加载数据...</p>';
            return;
        }
        this.renderDaySelector();
        this.renderVersionList();
        this.renderVersionDetail();
    }


    renderDaySelector() {
        this.elements.dayBtns.forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.day) === this.currentDay);
        });
    }

    renderVersionLinks(links) {
        if (!links || links.length === 0) return '';
        return links.map(link =>
            `<a href="${this.escapeHtml(link.url)}" target="_blank" class="version-link" title="${this.escapeHtml(link.title)}">🔗</a>`
        ).join(' ');
    }

    renderVersionLinksDetailed(links) {
        if (!links || links.length === 0) return '';
        return `<div class="version-links-flex">` +
            links.map(link =>
                `<a href="${this.escapeHtml(link.url)}" target="_blank" class="version-link-item">🔗 ${this.escapeHtml(link.title)}</a>`
            ).join('') +
            `</div>`;
    }

    renderVersionList() {
        this.elements.versionList.innerHTML = '';

        this.data.versions.forEach((version, index) => {
            const item = document.createElement('div');
            item.className = 'version-item ' + (this.selectedVersionId === version.id ? 'active' : '');

            let statusClass, statusText;
            switch (version.status) {
                case 'skip':
                    statusClass = 'version-status-skip';
                    statusText = '跳过';
                    break;
                case 'inactive':
                    statusClass = 'version-status-inactive';
                    statusText = '非活跃';
                    break;
                default:
                    statusClass = 'version-status-active';
                    statusText = '活跃';
            }

            item.innerHTML = `
                <div class="version-item-header">
                    <div class="version-item-name">${this.escapeHtml(version.name)}</div>
                </div>
                <div class="version-item-versions">
                    ${this.escapeHtml(version.currentVersion || '')} | 上一个: ${this.escapeHtml(version.previousVersion || '')}
                </div>
                <div class="version-item-info">
                    <span class="version-status ${statusClass}">${statusText}</span>
                    ${version.manager ? `<span class="version-manager">版本负责人: ${this.escapeHtml(version.manager)}</span>` : ''}
                </div>
                <div class="version-item-actions">
                    ${index > 0 ? `<button class="move-btn move-up" onclick="event.stopPropagation(); app.moveVersionUp(${index})">↑</button>` : ''}
                    ${index < this.data.versions.length - 1 ? `<button class="move-btn move-down" onclick="event.stopPropagation(); app.moveVersionDown(${index})">↓</button>` : ''}
                </div>
            `;
            item.addEventListener('click', () => {
                this.selectedVersionId = version.id;
                this.renderVersionList();
                this.renderVersionDetail();
            });
            this.elements.versionList.appendChild(item);
        });
    }

    renderVersionDetail() {
        if (!this.selectedVersionId) {
            this.elements.versionDetail.innerHTML = '<p class="placeholder">请选择一个版本查看详情</p>';
            return;
        }

        const version = this.data.versions.find(v => v.id === this.selectedVersionId);
        if (!version) {
            this.elements.versionDetail.innerHTML = '<p class="placeholder">版本不存在</p>';
            return;
        }

        const dayKey = 'day_' + this.currentDay;
        const checklist = this.data.checklists[version.id + '_' + dayKey] || [];
        const email = this.data.emails[version.id + '_' + dayKey] || {};

        const isMonday = this.currentDay === 1;

        let statusClass, statusText;
        switch (version.status) {
            case 'skip':
                statusClass = 'version-status-skip';
                statusText = '跳过';
                break;
            case 'inactive':
                statusClass = 'version-status-inactive';
                statusText = '非活跃';
                break;
            default:
                statusClass = 'version-status-active';
                statusText = '活跃';
        }

        this.elements.versionDetail.innerHTML = `
            <div class="detail-header">
                <div class="detail-info">
                    <h2>${this.escapeHtml(version.name)}</h2>
                    <div class="versions">
                        <span class="version-badge">当前版本: ${this.escapeHtml(version.currentVersion || '')}</span>
                        <span class="version-badge">上一个版本: ${this.escapeHtml(version.previousVersion || '')}</span>
                        <div class="version-status ${statusClass}">本周状态: ${statusText}</div>
                    </div>
                    ${version.notes ? '<div class="notes">注意事项: ' + this.escapeHtml(version.notes) + '</div>' : ''}
                    <div class="version-additional-info">
                        ${this.renderVersionLinksDetailed(version.links)}
                        ${version.manager ? `<div class="version-manager-display">版本负责人: ${this.escapeHtml(version.manager)}</div>` : ''}
                    </div>
                </div>
                <div class="detail-actions">
                    <button class="btn btn-secondary" onclick="app.editVersion('${version.id}')">编辑</button>
                    <button class="btn btn-warning" onclick="app.showCopyChecklistModal('${version.id}')">复制checklist</button>
                    <button class="btn btn-danger" onclick="app.deleteVersion('${version.id}')">删除</button>
                </div>
            </div>
            ${this.renderChecklistSection(version.id, dayKey, checklist)}
            ${isMonday ? this.renderEmailSection(version.id, dayKey, email) : ''}
        `;

        this.bindChecklistEvents(version.id, dayKey);
        if (isMonday) {
            this.bindEmailEvents(version.id, dayKey);
        }
    }

    renderChecklistSection(versionId, dayKey, checklist) {
        const allCompleted = checklist.length > 0 && checklist.every(item => item.completed);

        let checklistHtml = `
            <div class="section">
                <div class="section-header">
                    <h3>维护任务清单 ${allCompleted ? '✓' : ''}</h3>
                    <div>
                        <button class="btn btn-cancel-check btn-sm" onclick="app.cancelChecklist('${versionId}', '${dayKey}')">取消check</button>
                        <span class="version-badge" style="margin-left: 12px;">${checklist.filter(i => i.completed).length}/${checklist.length} 完成</span>
                    </div>
                </div>
                <div class="checklist" id="checklist-${versionId}-${dayKey}">
        `;

        checklist.forEach((item, index) => {
            const statusBadge = this.getTaskStatusBadge(item.taskStatus);
            const expandKey = versionId + '_' + dayKey + '_' + index;
            const isExpanded = this.expandedSubtasks[expandKey] || false;
            checklistHtml += `
                <div class="checklist-item ${item.completed ? 'completed' : ''}" data-index="${index}">
                    <div class="checklist-item-row">
                        <input type="checkbox" ${item.completed ? 'checked' : ''} onchange="app.toggleChecklistItem('${versionId}', '${dayKey}', ${index})">
                        <div class="checklist-item-content">
                            <span class="checklist-item-text">${this.escapeHtml(item.text)}</span>
                            ${statusBadge}
                            ${item.cautions ? '<div class="checklist-item-cautions">' + this.escapeHtmlWithLineBreaks(item.cautions) + '</div>' : ''}
                            ${item.notes ? '<div class="checklist-item-remarks">' + this.escapeHtmlWithLineBreaks(item.notes) + '</div>' : ''}
                            ${item.image ? '<img src="' + item.image + '" alt="备注图片" class="checklist-item-image" onclick="app.showImageModal(\'' + item.image + '\')">' : ''}
                            ${item.link ? '<a href="' + this.escapeHtml(item.link) + '" target="_blank" class="checklist-item-link">🔗 链接</a>' : ''}
                            ${item.suggestTime ? '<span class="checklist-item-suggest-time">建议完成时间：' + this.escapeHtml(item.suggestTime) + '</span>' : ''}
                            ${item.completedAt ? '<span class="checklist-item-time">' + this.escapeHtml(item.completedAt) + '</span>' : ''}
                        </div>
                        <div class="checklist-item-actions">
                            ${index > 0 ? `<button class="move-btn btn-sm move-up" onclick="event.stopPropagation(); app.moveChecklistItemUp('${versionId}', '${dayKey}', ${index})">↑</button>` : ''}
                            ${index < checklist.length - 1 ? `<button class="move-btn btn-sm move-down" onclick="event.stopPropagation(); app.moveChecklistItemDown('${versionId}', '${dayKey}', ${index})">↓</button>` : ''}
                            <button class="btn btn-secondary btn-sm expand-toggle-btn" onclick="app.toggleExpandSubtasks('${versionId}', '${dayKey}', ${index})" title="${isExpanded ? '收缩子任务' : '展开子任务'}">${isExpanded ? '▼' : '▶'} (${item.subtasks && item.subtasks.length || 0})</button>
                            <button class="btn btn-secondary" onclick="app.editChecklistItem('${versionId}', '${dayKey}', ${index})">编辑</button>
                            <button class="btn btn-secondary" onclick="app.showCopyTaskModal('${versionId}', '${dayKey}', ${index})">复制</button>
                            <button class="btn btn-danger" onclick="app.deleteChecklistItem('${versionId}', '${dayKey}', ${index})">删除</button>
                        </div>
                    </div>
                </div>
                ${isExpanded ? this.renderSubtasks(versionId, dayKey, index, item.subtasks || []) : ''}
            `;
        });

        checklistHtml += `
                    <div class="add-task-form">
                        <input type="text" id="newTask-${versionId}-${dayKey}" placeholder="添加新任务..." onkeypress="if(event.key==='Enter') app.addChecklistItem('${versionId}', '${dayKey}')">
                        <button class="btn btn-primary" onclick="app.addChecklistItem('${versionId}', '${dayKey}')">添加</button>
                    </div>
                </div>
            </div>
        `;

        return checklistHtml;
    }

    renderSubtasks(versionId, dayKey, parentIndex, subtasks) {
        let subtasksHtml = '<div class="subtasks">';

        subtasks.forEach((subtask, subIndex) => {
            const statusBadge = this.getTaskStatusBadge(subtask.taskStatus);
            subtasksHtml += `
                <div class="checklist-item subtask ${subtask.completed ? 'completed' : ''}" data-parent="${parentIndex}" data-index="${subIndex}">
                    <div class="checklist-item-row">
                        <input type="checkbox" ${subtask.completed ? 'checked' : ''} onchange="app.toggleSubtaskItem('${versionId}', '${dayKey}', ${parentIndex}, ${subIndex})">
                        <div class="checklist-item-content">
                            <span class="checklist-item-text">${this.escapeHtml(subtask.text)}</span>
                            ${statusBadge}
                            ${subtask.cautions ? '<div class="checklist-item-cautions">' + this.escapeHtmlWithLineBreaks(subtask.cautions) + '</div>' : ''}
                            ${subtask.notes ? '<div class="checklist-item-remarks">' + this.escapeHtmlWithLineBreaks(subtask.notes) + '</div>' : ''}
                            ${subtask.image ? '<img src="' + subtask.image + '" alt="备注图片" class="checklist-item-image" onclick="app.showImageModal(\'' + subtask.image + '\')">' : ''}
                            ${subtask.link ? '<a href="' + this.escapeHtml(subtask.link) + '" target="_blank" class="checklist-item-link">🔗 链接</a>' : ''}
                            ${subtask.suggestTime ? '<span class="checklist-item-suggest-time">建议完成时间：' + this.escapeHtml(subtask.suggestTime) + '</span>' : ''}
                        </div>
                        <div class="checklist-item-actions">
                            ${subIndex > 0 ? `<button class="move-btn btn-sm move-up" onclick="event.stopPropagation(); app.moveSubtaskUp('${versionId}', '${dayKey}', ${parentIndex}, ${subIndex})">↑↑</button>` : ''}
                            ${subIndex < subtasks.length - 1 ? `<button class="move-btn btn-sm move-down" onclick="event.stopPropagation(); app.moveSubtaskDown('${versionId}', '${dayKey}', ${parentIndex}, ${subIndex})">↓</button>` : ''}
                            <button class="btn btn-secondary btn-sm" onclick="app.editSubtaskItem('${versionId}', '${dayKey}', ${parentIndex}, ${subIndex})">编辑</button>
                            <button class="btn btn-danger" onclick="app.deleteSubtaskItem('${versionId}', '${dayKey}', ${parentIndex}, ${subIndex})">删除</button>
                        </div>
                    </div>
                </div>
            `;
        });

        subtasksHtml += `
                    <div class="add-subtask-form">
                        <input type="text" id="newSubtask-${versionId}-${dayKey}-${parentIndex}" placeholder="添加子任务..." onkeypress="if(event.key==='Enter') app.addSubtaskItem('${versionId}', '${dayKey}', ${parentIndex})">
                        <button class="btn btn-primary btn-sm" onclick="app.addSubtaskItem('${versionId}', '${dayKey}', ${parentIndex})">添加</button>
                    </div>
                </div>
        `;

        return subtasksHtml;
    }

    getTaskStatusBadge(status) {
        if (!status) return '';
        let statusClass, statusText;
        switch (status) {
            case 'in-progress':
                statusClass = 'task-status-in-progress';
                statusText = '完成中';
                break;
            case 'completed':
                statusClass = 'task-status-completed';
                statusText = '已完成';
                break;
            case 'pending':
            default:
                statusClass = 'task-status-pending';
                statusText = '待选择';
        }
        return `<span class="task-status-badge ${statusClass}">${statusText}</span>`;
    }

    renderEmailSection(versionId, dayKey, email) {
        return `
            <div class="section">
                <div class="section-header">
                    <h3>邮件配置</h3>
                </div>
                <div class="email-section" id="email-${versionId}-${dayKey}">
                    <div class="email-form">
                        <div class="form-group">
                            <label>收件人</label>
                            <textarea id="email-from-${versionId}-${dayKey}" placeholder="收件人邮箱（多个换行填写）" style="white-space: pre-wrap;">${this.escapeHtml(email.from || '')}</textarea>
                        </div>
                        <div class="form-group">
                            <label>抄送人（多个邮箱）用逗号分隔）</label>
                            <input type="text" id="email-cc-${versionId}-${dayKey}" value="${this.escapeHtml(email.cc || '')}" placeholder="cc@example.com, cc2@example.com">
                        </div>
                        <div class="form-group">
                            <label>邮件主题【每周替换当前版本的版本号】</label>
                            <input type="text" id="email-subject-${versionId}-${dayKey}" value="${this.escapeHtml(email.subject || '')}" placeholder="邮件主题">
                        </div>
                        <div class="form-group">
                            <label>邮件内容</label>
                            <textarea id="email-content-${versionId}-${dayKey}" placeholder="邮件内容..." style="white-space: pre-wrap;">${this.escapeHtml(email.content || '')}</textarea>
                        </div>
                        <button class="btn btn-primary" onclick="app.saveEmail('${versionId}', '${dayKey}')">保存邮件配置</button>
                    </div>
                </div>
            </div>
        `;
    }

    bindChecklistEvents(versionId, dayKey) {
        // 事件通过内联onclick绑定
    }

    bindEmailEvents(versionId, dayKey) {
        // 事件通过内联onclick绑定
    }

    toggleIncompletePanel() {
        const panel = document.getElementById('incompletePanel');
        if (panel) {
            panel.classList.toggle('active');
            if (panel.classList.contains('active')) {
                // Reset filters
                const filterDay = document.getElementById('filterDay');
                const filterVersion = document.getElementById('filterVersion');
                if (filterDay) filterDay.value = '';
                if (filterVersion) filterVersion.value = '';
                this.populateVersionFilter();
                this.renderIncompleteTasks();
            }
        }
    }

    populateVersionFilter() {
        const versionSelect = document.getElementById('filterVersion');
        if (!versionSelect || !this.data || !this.data.versions) return;

        const activeVersions = this.data.versions.filter(v => v.status !== 'inactive');
        versionSelect.innerHTML = '<option value="">全部</option>' +
            activeVersions.map(v => `<option value="${v.id}">${this.escapeHtml(v.name)}</option>`).join('');
    }

    applyIncompleteFilters() {
        this.renderIncompleteTasks();
    }

    hideIncompletePanel() {
        const panel = document.getElementById('incompletePanel');
        if (panel) {
            panel.classList.remove('active');
        }
    }

    getAllIncompleteTasks() {
        const incompleteTasks = [];
        const dayNames = { 1: '周一', 4: '周四', 5: '周五' };

        if (!this.data || !this.data.versions) return incompleteTasks;

        this.data.versions.forEach(version => {
            // 跳过非活跃状态的版本
            if (version.status === 'inactive') return;

            [1, 4, 5].forEach(day => {
                const dayKey = 'day_' + day;
                const checklistKey = version.id + '_' + dayKey;
                const checklist = this.data.checklists[checklistKey] || [];

                checklist.forEach((item, index) => {
                    if (!item.completed) {
                        incompleteTasks.push({
                            type: 'main',
                            versionId: version.id,
                            versionName: version.name,
                            day: day,
                            dayName: dayNames[day],
                            dayKey: dayKey,
                            index: index,
                            text: item.text,
                            hasSubtasks: item.subtasks && item.subtasks.length > 0,
                            subtaskCount: item.subtasks ? item.subtasks.filter(s => !s.completed).length : 0
                        });
                    }

                    // Check subtasks
                    if (item.subtasks && item.subtasks.length > 0) {
                        item.subtasks.forEach((subtask, subIndex) => {
                            if (!subtask.completed) {
                                incompleteTasks.push({
                                    type: 'subtask',
                                    versionId: version.id,
                                    versionName: version.name,
                                    day: day,
                                    dayName: dayNames[day],
                                    dayKey: dayKey,
                                    parentIndex: index,
                                    index: subIndex,
                                    text: subtask.text,
                                    parentText: item.text
                                });
                            }
                        });
                    }
                });
            });
        });

        return incompleteTasks;
    }

    renderIncompleteTasks() {
        const list = document.getElementById('incompleteList');
        const countEl = document.getElementById('incompleteCount');
        let tasks = this.getAllIncompleteTasks();

        // Apply filters
        const filterDay = document.getElementById('filterDay')?.value;
        const filterVersion = document.getElementById('filterVersion')?.value;

        if (filterDay) {
            tasks = tasks.filter(t => t.day === parseInt(filterDay));
        }
        if (filterVersion) {
            tasks = tasks.filter(t => t.versionId === filterVersion);
        }

        if (countEl) {
            countEl.textContent = tasks.length;
        }

        if (!list) return;

        if (tasks.length === 0) {
            list.innerHTML = `
                <div class="incomplete-empty">
                    <div class="incomplete-empty-icon">🎉</div>
                    <div class="incomplete-empty-text">太棒了！所有任务都已完成</div>
                </div>
            `;
            return;
        }

        list.innerHTML = tasks.map((task, i) => {
            if (task.type === 'subtask') {
                return `
                    <div class="incomplete-item" onclick="app.navigateToTask('${task.versionId}', ${task.day}, ${task.parentIndex}, ${task.index})">
                        <div class="incomplete-item-version">
                            ${this.escapeHtml(task.versionName)}
                            <span class="incomplete-item-day">${task.dayName}</span>
                        </div>
                        <div class="incomplete-item-text">${this.escapeHtml(task.parentText)}</div>
                        <div class="incomplete-item-subtask">↳ ${this.escapeHtml(task.text)}</div>
                    </div>
                `;
            } else {
                const subtaskInfo = task.hasSubtasks ? ` (含 ${task.subtaskCount} 个未完成子任务)` : '';
                return `
                    <div class="incomplete-item" onclick="app.navigateToTask('${task.versionId}', ${task.day}, ${task.index})">
                        <div class="incomplete-item-version">
                            ${this.escapeHtml(task.versionName)}
                            <span class="incomplete-item-day">${task.dayName}</span>
                        </div>
                        <div class="incomplete-item-text">${this.escapeHtml(task.text)}${subtaskInfo}</div>
                    </div>
                `;
            }
        }).join('');
    }

    navigateToTask(versionId, day, parentIndex, subIndex = null) {
        this.hideIncompletePanel();

        // Set the day
        this.currentDay = day;

        // Select the version
        this.selectedVersionId = versionId;

        // Render to update the UI
        this.render();

        // Scroll to the task after a brief delay to allow rendering
        setTimeout(() => {
            let targetSelector;
            if (subIndex !== null) {
                // Navigate to subtask
                targetSelector = `.subtask[data-parent="${parentIndex}"][data-index="${subIndex}"]`;
            } else {
                // Navigate to main task
                targetSelector = `.checklist-item[data-index="${parentIndex}"]`;
            }

            const targetEl = document.querySelector(targetSelector);
            if (targetEl) {
                targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                targetEl.style.animation = 'highlight-pulse 1s ease';
            }

            // If it's a main task with subtasks, expand them
            if (subIndex === null && parentIndex !== undefined) {
                const expandKey = versionId + '_day_' + day + '_' + parentIndex;
                if (!this.expandedSubtasks[expandKey]) {
                    this.expandedSubtasks[expandKey] = true;
                    this.renderVersionDetail();
                    // Re-scroll after expanding subtasks
                    setTimeout(() => {
                        const expandedEl = document.querySelector(targetSelector);
                        if (expandedEl) {
                            expandedEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    }, 100);
                }
            }
        }, 100);
    }

    showModal(content) {
        this.elements.modalBody.innerHTML = content;
        this.elements.modal.classList.add('active');
    }

    hideModal() {
        this.elements.modal.classList.remove('active');
    }

    showAddVersionModal() {
        this.showModal(`
            <h2>添加版本</h2>
            <div class="form-group">
                <label>版本名称</label>
                <input type="text" id="modal-version-name" placeholder="例如: 主版本">
            </div>
            <div class="form-group">
                <label>当前版本号</label>
                <input type="text" id="modal-version-current" placeholder="例如: 1.2.3">
            </div>
            <div class="form-group">
                <label>上一个版本号</label>
                <input type="text" id="modal-version-previous" placeholder="例如: 1.2.2">
            </div>
            <div class="form-group">
                <label>链接（可选，最多10个）</label>
                <div id="modal-version-links-container">
                </div>
                <button type="button" class="btn btn-secondary btn-sm" onclick="app.addVersionLinkField()" style="margin-top: 8px;">+ 添加链接</button>
            </div>
            <div class="form-group">
                <label>本周状态</label>
                <select id="modal-version-status">
                    <option value="active">活跃</option>
                    <option value="inactive">非活跃</option>
                    <option value="skip">跳过</option>
                </select>
            </div>
            <div class="form-group">
                <label>版本负责人</label>
                <input type="text" id="modal-version-manager" placeholder="例如: 张三">
            </div>
            <div class="form-group">
                <label>注意事项</label>
                <textarea id="modal-version-notes" placeholder="注意事项..."></textarea>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="app.hideModal()">取消</button>
                <button class="btn btn-primary" onclick="app.confirmAddVersion()">添加</button>
            </div>
        `);
        this.addVersionLinkField();
    }

    addVersionLinkField(title = '', url = '') {
        const container = document.getElementById('modal-version-links-container');
        if (!container) return;
        const count = container.querySelectorAll('.version-link-row').length;
        if (count >= 10) {
            alert('最多只能添加10个链接');
            return;
        }
        const row = document.createElement('div');
        row.className = 'version-link-row';
        row.style.display = 'flex';
        row.style.gap = '8px';
        row.style.marginBottom = '8px';
        row.style.alignItems = 'center';

        const titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.className = 'version-link-title';
        titleInput.placeholder = '链接标题';
        titleInput.value = title; // 直接设置 value，避免 HTML 转义问题

        const urlInput = document.createElement('input');
        urlInput.type = 'url';
        urlInput.className = 'version-link-url';
        urlInput.placeholder = 'https://...';
        urlInput.value = url; // 直接设置 value

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn btn-danger btn-sm';
        deleteBtn.textContent = '删除';
        deleteBtn.onclick = () => {
            row.remove();
            this.updateRemoveVersionLinkButtons();
        };

        row.appendChild(titleInput);
        row.appendChild(urlInput);
        row.appendChild(deleteBtn);
        container.appendChild(row);
        this.updateRemoveVersionLinkButtons();
    }

    updateRemoveVersionLinkButtons() {
        const container = document.getElementById('modal-version-links-container');
        if (!container) return;
        const rows = container.querySelectorAll('.version-link-row');
        rows.forEach((row, i) => {
            const btn = row.querySelector('button');
            if (btn && rows.length === 1) {
                btn.style.display = 'none';
            } else if (btn) {
                btn.style.display = '';
            }
        });
    }

    collectVersionLinks() {
        const container = document.getElementById('modal-version-links-container');
        if (!container) return [];
        const links = [];
        container.querySelectorAll('.version-link-row').forEach(row => {
            const title = row.querySelector('.version-link-title').value.trim();
            const url = row.querySelector('.version-link-url').value.trim();
            if (url) {
                links.push({title: title || '链接', url});
            }
        });
        return links;
    }

    showEditVersionModal(version) {
        const links = version.links || [];
        this.showModal(`
            <h2>编辑版本</h2>
            <div class="form-group">
                <label>版本名称</label>
                <input type="text" id="modal-version-name" value="${this.escapeHtml(version.name)}">
            </div>
            <div class="form-group">
                <label>当前版本号</label>
                <input type="text" id="modal-version-current" value="${this.escapeHtml(version.currentVersion || '')}">
            </div>
            <div class="form-group">
                <label>上一个版本号</label>
                <input type="text" id="modal-version-previous" value="${this.escapeHtml(version.previousVersion || '')}">
            </div>
            <div class="form-group">
                <label>链接（可选，最多10个）</label>
                <div id="modal-version-links-container">
                </div>
                <button type="button" class="btn btn-secondary btn-sm" onclick="app.addVersionLinkField()" style="margin-top: 8px;">+ 添加链接</button>
            </div>
            <div class="form-group">
                <label>本周状态</label>
                <select id="modal-version-status">
                    <option value="active" ${version.status === 'active' ? 'selected' : ''}>活跃</option>
                    <option value="inactive" ${version.status === 'inactive' ? 'selected' : ''}>非活跃</option>
                    <option value="skip" ${version.status === 'skip' ? 'selected' : ''}>跳过</option>
                </select>
            </div>
            <div class="form-group">
                <label>版本负责人</label>
                <input type="text" id="modal-version-manager" value="${this.escapeHtml(version.manager || '')}" placeholder="例如: 张三">
            </div>
            <div class="form-group">
                <label>注意事项</label>
                <textarea id="modal-version-notes">${this.escapeHtml(version.notes || '')}</textarea>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="app.hideModal()">取消</button>
                <button class="btn btn-primary" onclick="app.confirmEditVersion('${version.id}')">保存</button>
            </div>
        `);
        // 填充现有链接
        links.forEach(link => {
            this.addVersionLinkField(link.title, link.url);
        });
        if (links.length === 0) {
            this.addVersionLinkField();
        }
    }

    showEditChecklistItemModal(versionId, dayKey, index, text, cautions, notes, suggestTime, link, taskStatus = null, isSubtask = false, parentIndex = null, subIndex = null) {
        const title = isSubtask ? '编辑子任务' : '编辑任务';
        const hasStatus = taskStatus !== null && taskStatus !== undefined;
        const existingImage = this.renderExistingImage(versionId, dayKey, index, isSubtask ? parentIndex : null, isSubtask ? subIndex : null);
        this.showModal(`
            <h2>${title}</h2>
            <div class="form-group">
                <label>任务内容</label>
                <input type="text" id="modal-checklist-text" value="${this.escapeHtml(text)}">
            </div>
            <div class="form-group" style="flex-direction: row; align-items: center; justify-content: flex-start; gap: 8px;">
                <label style="margin: 0;">启用状态功能</label>
                <input type="checkbox" id="modal-checklist-enable-status" ${hasStatus ? 'checked' : ''} onchange="document.getElementById('modal-checklist-status-group').style.display = this.checked ? 'block' : 'none'">
            </div>
            <div class="form-group" id="modal-checklist-status-group" style="display: ${hasStatus ? 'block' : 'none'}">
                <label>状态</label>
                <select id="modal-checklist-status">
                    <option value="pending" ${taskStatus === 'pending' ? 'selected' : ''}>待选择</option>
                    <option value="in-progress" ${taskStatus === 'in-progress' ? 'selected' : ''}>完成中</option>
                    <option value="completed" ${taskStatus === 'completed' ? 'selected' : ''}>已完成</option>
                </select>
            </div>
            <div class="form-group">
                <label>注意事项（红色显示）</label>
                <textarea id="modal-checklist-cautions" placeholder="添加注意事项...">${this.escapeHtml(cautions || '')}</textarea>
            </div>
            <div class="form-group">
                <label>备注（黑色显示）</label>
                <textarea id="modal-checklist-notes" placeholder="添加备注...">${this.escapeHtml(notes || '')}</textarea>
            </div>
            <div class="form-group">
                <label>图片</label>
                <input type="file" id="modal-checklist-image" accept="image/*" onchange="app.handleImagePreview(this)">
                <div id="modal-image-preview" style="margin-top: 8px; max-width: 200px;">
                    ${existingImage}
                </div>
                <button type="button" class="btn btn-danger btn-sm" onclick="app.removeImage()" style="margin-top: 8px;">删除图片</button>
                <input type="hidden" id="modal-checklist-image-removed" value="0">
            </div>
            <div class="form-group">
                <label>链接</label>
                <input type="url" id="modal-checklist-link" value="${this.escapeHtml(link || '')}" placeholder="https://...">
            </div>
            <div class="form-group">
                <label>建议完成时间（可选）</label>
                <input type="time" id="modal-checklist-suggest-time" value="${this.escapeHtml(suggestTime || '')}">
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="app.hideModal()">取消</button>
                <button class="btn btn-primary" onclick="app.confirmEditChecklistItem('${versionId}', '${dayKey}', ${index}, ${isSubtask}, ${parentIndex}, ${subIndex})">保存</button>
            </div>
        `);
    }

    showCopyChecklistModal(versionId) {
        const otherVersions = this.data.versions.filter(v => v.id !== versionId);
        const dayKey = 'day_' + this.currentDay;

        let versionOptions = '';
        otherVersions.forEach(version => {
            versionOptions += `<option value="${version.id}">${this.escapeHtml(version.name)}</option>`;
        });

        if (otherVersions.length === 0) {
            this.showModal(`
                <h2>复制checklist</h2>
                <p>没有其他版本可以复制。</p>
                <div class="modal-actions">
                    <button class="btn btn-secondary" onclick="app.hideModal()">关闭</button>
                </div>
            `);
            return;
        }

        const dayNames = {
            1: '周一',
            4: '周四',
            5: '周五'
        };

        this.showModal(`
            <h2>复制checklist</h2>
            <p>从其他版本复制${dayNames[this.currentDay] || '当前'}的checklist到当前版本</p>
            <div class="form-group">
                <label>选择源版本</label>
                <select id="modal-copy-source-version">
                    ${versionOptions}
                </select>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="app.hideModal()">取消</button>
                <button class="btn btn-primary" onclick="app.confirmCopyChecklist('${versionId}')">复制</button>
            </div>
        `);
    }

    showImageModal(imageSrc) {
        this.elements.modal.classList.add('image-modal');
        this.showModal(`
            <div style="text-align: center;">
                <img src="${imageSrc}" alt="图片" style="max-width: 100%; max-height: 85vh; border-radius: 8px;">
                <div class="modal-actions" style="justify-content: center; margin-top: 20px;">
                    <button class="btn btn-secondary" onclick="app.hideModal()">关闭</button>
                </div>
            </div>
        `);
    }

    hideModal() {
        this.elements.modal.classList.remove('active');
        this.elements.modal.classList.remove('image-modal');
    }

    confirmAddVersion() {
        const name = document.getElementById('modal-version-name').value.trim();
        const currentVersion = document.getElementById('modal-version-current').value.trim();
        const previousVersion = document.getElementById('modal-version-previous').value.trim();
        const links = this.collectVersionLinks();
        const status = document.getElementById('modal-version-status') ? document.getElementById('modal-version-status').value : 'active';
        const manager = document.getElementById('modal-version-manager') ? document.getElementById('modal-version-manager').value.trim() : '';
        const notes = document.getElementById('modal-version-notes').value.trim();

        if (!name) {
            alert('请输入版本名称');
            return;
        }

        const version = {
            id: Date.now().toString(),
            name,
            currentVersion,
            previousVersion,
            links,
            status,
            manager,
            notes
        };

        this.data.versions.push(version);
        this.saveData();
        this.hideModal();
        this.renderVersionList();
        this.showToast('版本添加成功');
    }

    editVersion(id) {
        const version = this.data.versions.find(v => v.id === id);
        if (version) {
            this.showEditVersionModal(version);
        }
    }

    confirmEditVersion(id) {
        const version = this.data.versions.find(v => v.id === id);
        if (!version) return;

        version.name = document.getElementById('modal-version-name').value.trim();
        version.currentVersion = document.getElementById('modal-version-current').value.trim();
        version.previousVersion = document.getElementById('modal-version-previous').value.trim();
        version.links = this.collectVersionLinks();
        version.status = document.getElementById('modal-version-status') ? document.getElementById('modal-version-status').value : 'active';
        version.manager = document.getElementById('modal-version-manager') ? document.getElementById('modal-version-manager').value.trim() : '';
        version.notes = document.getElementById('modal-version-notes').value.trim();

        if (!version.name) {
            alert('请输入版本名称');
            return;
        }

        this.saveData();
        this.hideModal();
        this.render();
        this.showToast('版本更新成功');
    }

    moveVersionUp(index) {
        if (index <= 0) return;
        const temp = this.data.versions[index];
        this.data.versions[index] = this.data.versions[index - 1];
        this.data.versions[index - 1] = temp;
        this.saveData();
        this.renderVersionList();
    }

    moveVersionDown(index) {
        if (index >= this.data.versions.length - 1) return;
        const temp = this.data.versions[index];
        this.data.versions[index] = this.data.versions[index + 1];
        this.data.versions[index + 1] = temp;
        this.saveData();
        this.renderVersionList();
    }

    deleteVersion(id) {
        if (confirm('确定要删除这个版本吗？相关的checklist和邮件配置也会被删除。')) {
            this.data.versions = this.data.versions.filter(v => v.id !== id);
            this.saveData();
            this.selectedVersionId = null;
            this.render();
            this.showToast('版本删除成功');
        }
    }

    addChecklistItem(versionId, dayKey) {
        const input = document.getElementById('newTask-' + versionId + '-' + dayKey);
        const text = input.value.trim();

        if (!text) return;

        const key = versionId + '_' + dayKey;
        if (!this.data.checklists[key]) {
            this.data.checklists[key] = [];
        }

        this.data.checklists[key].push({
            id: Date.now().toString(),
            text,
            cautions: '', // 注意事项（红色）
            notes: '', // 备注（黑色）
            subtasks: [],
            completed: false
        });

        this.saveData();
        this.renderVersionDetail();
        input.value = '';
    }

    toggleChecklistItem(versionId, dayKey, index) {
        const key = versionId + '_' + dayKey;
        if (this.data.checklists[key] && this.data.checklists[key][index]) {
            const parentItem = this.data.checklists[key][index];
            parentItem.completed = !parentItem.completed;

            if (parentItem.completed) {
                parentItem.completedAt = this.getCurrentTime();
                // 勾选主任务时，自动勾选所有子任务
                if (parentItem.subtasks && parentItem.subtasks.length > 0) {
                    parentItem.subtasks.forEach(subtask => {
                        subtask.completed = true;
                        subtask.completedAt = this.getCurrentTime();
                    });
                }
            } else {
                delete parentItem.completedAt;
                // 取消主任务勾选时，取消所有子任务的勾选
                if (parentItem.subtasks && parentItem.subtasks.length > 0) {
                    parentItem.subtasks.forEach(subtask => {
                        subtask.completed = false;
                        delete subtask.completedAt;
                    });
                }
            }

            this.saveData();
            this.renderVersionDetail();
        }
    }

    editChecklistItem(versionId, dayKey, index) {
        const key = versionId + '_' + dayKey;
        if (this.data.checklists[key] && this.data.checklists[key][index]) {
            const item = this.data.checklists[key][index];
            this.showEditChecklistItemModal(versionId, dayKey, index, item.text, item.cautions || '', item.notes || '', item.suggestTime || '', item.link || '', item.taskStatus, false);
        }
    }

    confirmEditChecklistItem(versionId, dayKey, index, isSubtask = false, parentIndex = null, subIndex = null) {
        const key = versionId + '_' + dayKey;
        const text = document.getElementById('modal-checklist-text').value.trim();

        let taskStatus = null;
        const enableStatus = document.getElementById('modal-checklist-enable-status');
        if (enableStatus && enableStatus.checked) {
            taskStatus = document.getElementById('modal-checklist-status') ? document.getElementById('modal-checklist-status').value : 'pending';
        }

        const cautions = document.getElementById('modal-checklist-cautions') ? document.getElementById('modal-checklist-cautions').value.trim() : '';
        const notes = document.getElementById('modal-checklist-notes') ? document.getElementById('modal-checklist-notes').value.trim() : '';
        const link = document.getElementById('modal-checklist-link') ? document.getElementById('modal-checklist-link').value.trim() : '';
        const suggestTime = document.getElementById('modal-checklist-suggest-time') ? document.getElementById('modal-checklist-suggest-time').value : '';
        const imageInput = document.getElementById('modal-checklist-image');

        if (!text) {
            alert('请输入任务内容');
            return;
        }

        // 处理图片
        const imageRemoved = document.getElementById('modal-checklist-image-removed') && document.getElementById('modal-checklist-image-removed').value === '1';
        if (imageInput && imageInput.files && imageInput.files[0]) {
            const reader = new FileReader();
            reader.onload = (e) => {
                this.saveItemWithImage(versionId, dayKey, index, isSubtask, parentIndex, subIndex, text, taskStatus, cautions, notes, link, suggestTime, e.target.result);
            };
            reader.readAsDataURL(imageInput.files[0]);
            // 重置删除标志
            if (document.getElementById('modal-checklist-image-removed')) {
                document.getElementById('modal-checklist-image-removed').value = '0';
            }
        } else if (imageRemoved) {
            // 用户删除了图片，传递null以删除
            this.saveItemWithImage(versionId, dayKey, index, isSubtask, parentIndex, subIndex, text, taskStatus, cautions, notes, link, suggestTime, null);
            // 重置删除标志
            if (document.getElementById('modal-checklist-image-removed')) {
                document.getElementById('modal-checklist-image-removed').value = '0';
            }
        } else {
            // 保留原有图片，传递undefined
            this.saveItemWithImage(versionId, dayKey, index, isSubtask, parentIndex, subIndex, text, taskStatus, cautions, notes, link, suggestTime, undefined);
        }
    }

    saveItemWithImage(versionId, dayKey, index, isSubtask, parentIndex, subIndex, text, taskStatus, cautions, notes, link, suggestTime, imageData) {
        const key = versionId + '_' + dayKey;

        if (isSubtask) {
            // 保存子任务
            if (this.data.checklists[key] && this.data.checklists[key][parentIndex] && this.data.checklists[key][parentIndex].subtasks && this.data.checklists[key][parentIndex].subtasks[subIndex]) {
                const subtask = this.data.checklists[key][parentIndex].subtasks[subIndex];
                subtask.text = text;
                subtask.taskStatus = taskStatus;
                subtask.cautions = cautions;
                subtask.notes = notes;
                subtask.link = link;
                subtask.suggestTime = suggestTime;
                // 如果有新图片则保存，如果imageData为null则删除，否则保持不变
                if (imageData === null) {
                    delete subtask.image;
                } else if (imageData !== undefined) {
                    subtask.image = imageData;
                }
                // 如果状态设置为已完成，自动勾选任务
                if (taskStatus === 'completed') {
                    subtask.completed = true;
                    subtask.completedAt = this.getCurrentTime();
                } else {
                    subtask.completed = false;
                    delete subtask.completedAt;
                }
                this.saveData();
                this.hideModal();
                this.renderVersionDetail();
            }
        } else {
            // 保存主任务
            if (this.data.checklists[key] && this.data.checklists[key][index]) {
                const item = this.data.checklists[key][index];
                item.text = text;
                item.taskStatus = taskStatus;
                item.cautions = cautions;
                item.notes = notes;
                item.link = link;
                item.suggestTime = suggestTime;
                // 如果有新图片则保存，如果imageData为null则删除，否则保持不变
                if (imageData === null) {
                    delete item.image;
                } else if (imageData !== undefined) {
                    item.image = imageData;
                }
                // 如果状态设置为已完成，自动勾选任务
                if (taskStatus === 'completed') {
                    item.completed = true;
                    item.completedAt = this.getCurrentTime();
                } else {
                    item.completed = false;
                    delete item.completedAt;
                }
                this.saveData();
                this.hideModal();
                this.renderVersionDetail();
            }
        }
    }

    deleteChecklistItem(versionId, dayKey, index) {
        if (confirm('确定要删除这个任务吗？')) {
            const key = versionId + '_' + dayKey;
            if (this.data.checklists[key]) {
                this.data.checklists[key].splice(index, 1);
                this.saveData();
                this.renderVersionDetail();
            }
        }
    }

    toggleExpandSubtasks(versionId, dayKey, index) {
        const expandKey = versionId + '_' + dayKey + '_' + index;
        this.expandedSubtasks[expandKey] = !this.expandedSubtasks[expandKey];
        this.renderVersionDetail();
    }

    toggleSubtasks(versionId, dayKey, index) {
        const key = versionId + '_' + dayKey;
        if (this.data.checklists[key] && this.data.checklists[key][index]) {
            if (!this.data.checklists[key][index].subtasks) {
                this.data.checklists[key][index].subtasks = [];
            }
            this.saveData();
            this.renderVersionDetail();
        }
    }

    addSubtaskItem(versionId, dayKey, index) {
        const input = document.getElementById('newSubtask-' + versionId + '-' + dayKey + '-' + index);
        const text = input.value.trim();

        if (!text) return;

        const key = versionId + '_' + dayKey;
        if (this.data.checklists[key] && this.data.checklists[key][index]) {
            const parentItem = this.data.checklists[key][index];
            if (!parentItem.subtasks) {
                parentItem.subtasks = [];
            }

            // 如果父任务已完成，添加子任务时取消父任务的完成状态
            if (parentItem.completed) {
                parentItem.completed = false;
                delete parentItem.completedAt;
            }

            parentItem.subtasks.push({
                id: Date.now().toString(),
                text,
                cautions: '', // 注意事项（红色）
                notes: '', // 备注（黑色）
                completed: false
            });

            this.saveData();
            this.renderVersionDetail();
        }
    }

    toggleSubtaskItem(versionId, dayKey, index, subIndex) {
        const key = versionId + '_' + dayKey;
        if (this.data.checklists[key] && this.data.checklists[key][index] && this.data.checklists[key][index].subtasks && this.data.checklists[key][index].subtasks[subIndex]) {
            this.data.checklists[key][index].subtasks[subIndex].completed = !this.data.checklists[key][index].subtasks[subIndex].completed;

            if (this.data.checklists[key][index].subtasks[subIndex].completed) {
                this.data.checklists[key][index].subtasks[subIndex].completedAt = this.getCurrentTime();
            } else {
                delete this.data.checklists[key][index].subtasks[subIndex].completedAt;
            }

            // 检查父任务的所有子任务状态
            const parentItem = this.data.checklists[key][index];
            if (parentItem.subtasks && parentItem.subtasks.length > 0) {
                const allSubtasksCompleted = parentItem.subtasks.every(subtask => subtask.completed);
                if (allSubtasksCompleted) {
                    // 所有子任务完成，自动勾选主任务
                    parentItem.completed = true;
                    parentItem.completedAt = this.getCurrentTime();
                } else {
                    // 有子任务未完成，取消主任务的勾选
                    parentItem.completed = false;
                    delete parentItem.completedAt;
                }
            }

            this.saveData();
            this.renderVersionDetail();
        }
    }

    editSubtaskItem(versionId, dayKey, index, subIndex) {
        const key = versionId + '_' + dayKey;
        if (this.data.checklists[key] && this.data.checklists[key][index] && this.data.checklists[key][index].subtasks && this.data.checklists[key][index].subtasks[subIndex]) {
            const subtask = this.data.checklists[key][index].subtasks[subIndex];
            this.showEditChecklistItemModal(versionId, dayKey, subIndex, subtask.text, subtask.cautions || '', subtask.notes || '', subtask.suggestTime || '', subtask.link || '', subtask.taskStatus, true, index, subIndex);
        }
    }

    deleteSubtaskItem(versionId, dayKey, index, subIndex) {
        if (confirm('确定要删除这个子任务吗？')) {
            const key = versionId + '_' + dayKey;
            if (this.data.checklists[key] && this.data.checklists[key][index] && this.data.checklists[key][index].subtasks) {
                this.data.checklists[key][index].subtasks.splice(subIndex, 1);

                // 删除子任务后检查父任务状态
                const parentItem = this.data.checklists[key][index];
                if (parentItem.subtasks && parentItem.subtasks.length > 0) {
                    const allSubtasksCompleted = parentItem.subtasks.every(subtask => subtask.completed);
                    if (allSubtasksCompleted) {
                        // 所有剩余子任务完成，自动勾选主任务
                        parentItem.completed = true;
                        parentItem.completedAt = this.getCurrentTime();
                    } else {
                        // 有子任务未完成，取消主任务的勾选
                        parentItem.completed = false;
                        delete parentItem.completedAt;
                    }
                } else {
                    // 没有子任务了，父任务状态保持不变
                }

                this.saveData();
                this.renderVersionDetail();
            }
        }
    }

    moveChecklistItemUp(versionId, dayKey, index) {
        const key = versionId + '_' + dayKey;
        if (index <= 0 || !this.data.checklists[key]) return;
        const temp = this.data.checklists[key][index];
        this.data.checklists[key][index] = this.data.checklists[key][index - 1];
        this.data.checklists[key][index - 1] = temp;
        this.saveData();
        this.renderVersionDetail();
    }

    moveChecklistItemDown(versionId, dayKey, index) {
        const key = versionId + '_' + dayKey;
        if (index >= this.data.checklists[key].length - 1 || !this.data.checklists[key]) return;
        const temp = this.data.checklists[key][index];
        this.data.checklists[key][index] = this.data.checklists[key][index + 1];
        this.data.checklists[key][index + 1] = temp;
        this.saveData();
        this.renderVersionDetail();
    }

    saveEmail(versionId, dayKey) {
        const key = versionId + '_' + dayKey;
        this.data.emails[key] = {
            from: document.getElementById('email-from-' + versionId + '-' + dayKey).value.trim(),
            cc: document.getElementById('email-cc-' + versionId + '-' + dayKey).value.trim(),
            subject: document.getElementById('email-subject-' + versionId + '-' + dayKey).value.trim(),
            content: document.getElementById('email-content-' + versionId + '-' + dayKey).value.trim()
        };

        this.saveData();
        this.showToast('邮件配置保存成功');
    }

    moveSubtaskUp(versionId, dayKey, parentIndex, subIndex) {
        const key = versionId + '_' + dayKey;
        if (subIndex <= 0 || !this.data.checklists[key] || !this.data.checklists[key][parentIndex] || !this.data.checklists[key][parentIndex].subtasks) return;
        const subtasks = this.data.checklists[key][parentIndex].subtasks;
        const temp = subtasks[subIndex];
        subtasks[subIndex] = subtasks[subIndex - 1];
        subtasks[subIndex - 1] = temp;
        this.saveData();
        this.renderVersionDetail();
    }

    moveSubtaskDown(versionId, dayKey, parentIndex, subIndex) {
        const key = versionId + '_' + dayKey;
        if (!this.data.checklists[key] || !this.data.checklists[key][parentIndex] || !this.data.checklists[key][parentIndex].subtasks) return;
        const subtasks = this.data.checklists[key][parentIndex].subtasks;
        if (subIndex >= subtasks.length - 1) return;
        const temp = subtasks[subIndex];
        subtasks[subIndex] = subtasks[subIndex + 1];
        subtasks[subIndex + 1] = temp;
        this.saveData();
        this.renderVersionDetail();
    }

    async requestFileSystemAccess() {
        if (!this.fileSystemHandle) {
            try {
                // 尝试从 IndexedDB 获取之前保存的句柄
                const db = await this.openDB();
                const storedHandle = await this.getStoredHandle(db);

                const options = { mode: 'readwrite' };
                if (storedHandle) {
                    options.startIn = storedHandle;
                }
                this.fileSystemHandle = await window.showDirectoryPicker(options);

                // 保存新获取的句柄
                await this.storeHandle(db, this.fileSystemHandle);
            } catch (error) {
                console.log('File system access denied:', error);
                return false;
            }
        }
        return true;
    }

    async saveToLogDirectory(filename, dataStr, message) {
        try {
            if (!this.fileSystemHandle) {
                const hasAccess = await this.requestFileSystemAccess();
                if (!hasAccess) {
                    this.exportData(filename, message);
                    return;
                }
            }

            let logDirHandle;
            for await (const entry of this.fileSystemHandle.values()) {
                if (entry.kind === 'directory' && entry.name === 'log') {
                    logDirHandle = entry;
                    break;
                }
            }

            if (!logDirHandle) {
                logDirHandle = await this.fileSystemHandle.getDirectoryHandle('log', { create: true });
            }

            const fileHandle = await logDirHandle.getFileHandle(filename, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(dataStr);
            await writable.close();

            this.showToast(message);
        } catch (error) {
            console.log('Save to log directory failed:', error);
            this.exportData(filename, message);
        }
    }

    exportData(filename = null, message = '数据导出成功') {
        const dataStr = JSON.stringify(this.data, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || 'version-maintenance-' + new Date().toISOString().split('T')[0] + '.json';
        a.click();
        URL.revokeObjectURL(url);
        this.showToast(message);
    }

    async autoBackup(type) {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const timestamp = year + '-' + month + '-' + day + '-' + hours + minutes + seconds;

        const prefix = type === 'new-week' ? 'new-week-backup' : 'import-backup';
        const filename = prefix + '-' + timestamp + '.json';
        const backupMessage = type === 'new-week'
            ? '新的一周操作：已自动创建备份文件 (' + filename + ')'
            : '导入操作：已自动创建当前数据备份 (' + filename + ')';

        const dataStr = JSON.stringify(this.data, null, 2);
        await this.saveToLogDirectory(filename, dataStr, backupMessage);
    }

    async importData(file) {
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (data.versions && data.checklists && data.emails) {
                    if (confirm('导入将覆盖现有数据，确定要继续吗？')) {
                        await this.autoBackup('import');

                        Object.keys(data.checklists).forEach(key => {
                            if (data.checklists[key]) {
                                data.checklists[key] = data.checklists[key].map(item => ({
                                    ...item,
                                    // 兼容旧数据：将旧版notes重命名为cautions（注意事项），确保notes字段存在
                                    cautions: item.notes || item.cautions || '',
                                    notes: item.notes2 || item.notes || '',
                                    subtasks: item.subtasks ? item.subtasks.map(subtask => ({
                                        ...subtask,
                                        cautions: subtask.notes || subtask.cautions || '',
                                        notes: subtask.notes2 || subtask.notes || ''
                                    })) : []
                                }));
                            }
                        });

                        this.data = data;
                        this.saveData();
                        this.selectedVersionId = null;
                        this.render();
                        this.showToast('数据导入成功');
                    }
                } else {
                    alert('无效的数据格式');
                }
            } catch (error) {
                alert('文件解析失败: ' + error.message);
            }
        };
        reader.readAsText(file);
        if (this.elements.importFile) {
            this.elements.importFile.value = '';
        }
    }

    async startNewWeek() {
        const message = '确定要开始新的一周吗？\n此操作将会：\n1. 创建备份文件（浏览器会弹出下载，请手动保存）\n2. 将所有任务状态重置为待选择\n\n备份文件下载后可以随时通过"导入数据"功能恢复。';

        if (confirm(message)) {
            await this.autoBackup('new-week');

            Object.keys(this.data.checklists).forEach(key => {
                if (this.data.checklists[key]) {
                    this.data.checklists[key] = this.data.checklists[key].map(item => {
                        const newItem = {
                            ...item,
                            completed: false,
                            completedAt: null,
                            taskStatus: 'pending'
                        };

                        // 所有子任务也重置为待选择
                        if (newItem.subtasks && newItem.subtasks.length > 0) {
                            newItem.subtasks = newItem.subtasks.map(subtask => ({
                                ...subtask,
                                completed: false,
                                completedAt: null,
                                taskStatus: 'pending'
                            }));
                        }

                        return newItem;
                    });
                }
            });

            this.saveData();
            this.render();
            this.showToast('新的一周已开始，所有任务已重置为待选择');
        }
    }

    confirmCopyChecklist(versionId) {
        try {
            const sourceVersionId = document.getElementById('modal-copy-source-version').value;
            const dayKey = 'day_' + this.currentDay;
            const sourceKey = sourceVersionId + '_' + dayKey;
            const targetKey = versionId + '_' + dayKey;

            if (!sourceVersionId) {
                alert('请选择源版本');
                return;
            }

            if (!this.data.checklists[sourceKey] || this.data.checklists[sourceKey].length === 0) {
                alert('源版本的checklist为空，无法复制');
                return;
            }

            // 复制checklist，创建新的任务实例（包括所有子任务）
            this.data.checklists[targetKey] = this.data.checklists[sourceKey].map(item => ({
                ...item,
                id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
                completed: false,
                completedAt: null,
                subtasks: item.subtasks ? item.subtasks.map(subtask => ({
                    ...subtask,
                    id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
                    completed: false,
                    completedAt: null
                })) : []
            }));

            this.saveData();
            this.hideModal();
            this.renderVersionDetail();
            this.showToast('checklist复制成功');
        } catch (error) {
            alert('复制失败: ' + error.message);
            console.error('复制checklist失败:', error);
        }
    }

    showCopyTaskModal(versionId, dayKey, index) {
        const item = this.data.checklists[versionId + '_' + dayKey]?.[index];
        if (!item) return;

        const otherVersions = this.data.versions.filter(v => v.id !== versionId);

        if (otherVersions.length === 0) {
            alert('没有其他版本可以复制到');
            return;
        }

        let versionOptions = '';
        otherVersions.forEach(v => {
            versionOptions += `<option value="${v.id}">${this.escapeHtml(v.name)}</option>`;
        });

        this.showModal(`
            <h2>复制任务</h2>
            <p style="color: #666; margin-bottom: 16px;">任务：${this.escapeHtml(item.text)}</p>
            <div class="form-group">
                <label>目标版本</label>
                <select id="modal-copy-task-target-version">
                    ${versionOptions}
                </select>
            </div>
            <div class="form-group">
                <label>目标日期</label>
                <div style="display: flex; gap: 8px;">
                    <button type="button" class="btn btn-secondary" onclick="app.selectCopyTargetDay(1)" id="copy-day-1">周一</button>
                    <button type="button" class="btn btn-secondary" onclick="app.selectCopyTargetDay(4)" id="copy-day-4">周四</button>
                    <button type="button" class="btn btn-secondary" onclick="app.selectCopyTargetDay(5)" id="copy-day-5">周五</button>
                </div>
                <input type="hidden" id="modal-copy-task-target-day" value="">
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="app.hideModal()">取消</button>
                <button class="btn btn-primary" id="copy-task-confirm-btn" onclick="app.confirmCopyTask('${versionId}', '${dayKey}', ${index})" disabled>复制</button>
            </div>
        `);
    }

    selectCopyTargetDay(day) {
        document.getElementById('modal-copy-task-target-day').value = day;
        document.querySelectorAll('[id^="copy-day-"]').forEach(btn => btn.classList.remove('btn-primary'));
        document.querySelectorAll('[id^="copy-day-"]').forEach(btn => btn.classList.add('btn-secondary'));
        const btn = document.getElementById('copy-day-' + day);
        if (btn) {
            btn.classList.remove('btn-secondary');
            btn.classList.add('btn-primary');
        }
        const confirmBtn = document.getElementById('copy-task-confirm-btn');
        if (confirmBtn) confirmBtn.disabled = false;
    }

    confirmCopyTask(sourceVersionId, sourceDayKey, sourceIndex) {
        const targetVersionId = document.getElementById('modal-copy-task-target-version').value;
        const targetDay = document.getElementById('modal-copy-task-target-day').value;

        if (!targetVersionId || !targetDay) {
            alert('请选择目标版本和目标日期');
            return;
        }

        const targetDayKey = 'day_' + targetDay;
        const sourceKey = sourceVersionId + '_' + sourceDayKey;
        const targetKey = targetVersionId + '_' + targetDayKey;

        const item = this.data.checklists[sourceKey]?.[sourceIndex];
        if (!item) {
            alert('源任务不存在');
            return;
        }

        const newItem = {
            ...item,
            id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
            completed: false,
            completedAt: null,
            subtasks: item.subtasks ? item.subtasks.map(subtask => ({
                ...subtask,
                id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
                completed: false,
                completedAt: null
            })) : []
        };

        if (!this.data.checklists[targetKey]) {
            this.data.checklists[targetKey] = [];
        }
        this.data.checklists[targetKey].push(newItem);

        this.saveData();
        this.hideModal();
        this.renderVersionDetail();
        this.showToast('任务复制成功');
    }

    cancelChecklist(versionId, dayKey) {
        const key = versionId + '_' + dayKey;

        if (this.data.checklists[key]) {
            this.data.checklists[key] = this.data.checklists[key].map(item => {
                const newItem = {
                    ...item,
                    completed: false
                };

                // 取消所有子任务的勾选状态
                if (newItem.subtasks && newItem.subtasks.length > 0) {
                    newItem.subtasks = newItem.subtasks.map(subtask => ({
                        ...subtask,
                        completed: false
                    }));
                }

                return newItem;
            });

            this.saveData();
            this.renderVersionDetail();
            this.showToast('checklist已重置');
        }
    }

    getCurrentTime() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        return year + '-' + month + '-' + day + ' ' + hours + ':' + minutes;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    escapeHtmlWithLineBreaks(text) {
        // 先转义HTML特殊字符，然后将换行符转换为<br>标签
        const escaped = this.escapeHtml(text);
        return escaped.replace(/\n/g, '<br>');
    }

    renderExistingImage(versionId, dayKey, index, parentIndex, subIndex) {
        const key = versionId + '_' + dayKey;
        let item;
        if (parentIndex !== null && subIndex !== null) {
            // 子任务
            if (this.data.checklists[key] && this.data.checklists[key][parentIndex] && this.data.checklists[key][parentIndex].subtasks && this.data.checklists[key][parentIndex].subtasks[subIndex]) {
                item = this.data.checklists[key][parentIndex].subtasks[subIndex];
            }
        } else {
            // 主任务
            if (this.data.checklists[key] && this.data.checklists[key][index]) {
                item = this.data.checklists[key][index];
            }
        }
        if (item && item.image) {
            return `<img src="${item.image}" alt="备注图片" style="max-width: 100%; border-radius: 4px;">`;
        }
        return '';
    }

    handleImagePreview(input) {
        const file = input.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            const preview = document.getElementById('modal-image-preview');
            preview.innerHTML = `<img src="${e.target.result}" alt="预览" style="max-width: 100%; border-radius: 4px;">`;
        };
        reader.readAsDataURL(file);
    }

    removeImage() {
        const input = document.getElementById('modal-checklist-image');
        if (input) {
            input.value = '';
        }
        const preview = document.getElementById('modal-image-preview');
        if (preview) {
            preview.innerHTML = '';
        }
        const removedFlag = document.getElementById('modal-checklist-image-removed');
        if (removedFlag) {
            removedFlag.value = '1';
        }
    }

    showToast(message) {
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.remove();
        }, 3000);
    }
}

// 初始化应用
const app = new VersionMaintenanceApp();
