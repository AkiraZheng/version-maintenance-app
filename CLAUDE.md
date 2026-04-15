# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A single-page web application for managing version maintenance tasks across multiple versions and maintenance schedules (Thursday, Friday, Monday). The app features checklist management, email configuration, and automatic data persistence.

## Running the Application

### Local Server (Recommended)
```bash
cd /path/to/version-maintenance-app
python3 -m http.server 8000
# Access at http://localhost:8000
```
Running via HTTP server enables File System Access API for automatic file writing to the `data/` and `log/` directories.

### Direct File Access
Double-click `index.html` to open directly (data will only persist to localStorage, file backups must be manually downloaded).

## Architecture

### Application Structure

The entire application is contained in three main files:
- **`index.html`** - Main page structure with semantic HTML
- **`styles.css`** - Complete styling with responsive design and color variables
- **`app.js`** - All application logic in the `VersionMaintenanceApp` class (2000+ lines)

### Core Architecture Pattern

The app follows a vanilla JavaScript MVC-like pattern:
- **Model**: `this.data` object containing versions, checklists, and emails
- **View**: Render methods (`render()`, `renderVersionList()`, `renderVersionDetail()`, etc.)
- **Controller**: Event handlers and action methods

### Data Storage Strategy

Dual persistence layer for performance and reliability:

1. **localStorage** (`versionMaintenanceData` key)
   - Instant load on page open (no network requests)
   - Updated on every data change
   - 5MB size limit

2. **File System Access API** (Chrome/Edge 90+)
   - Writes to `data/data.json` in user-selected directory
   - Handles are persisted in IndexedDB for cross-session reuse
   - Automatic backups to `log/` directory with timestamped filenames
   - Graceful degradation if API unavailable

### Data Schema

```javascript
{
  versions: [{
    id: string,
    name: string,
    currentVersion: string,
    previousVersion: string,
    links: [{title: string, url: string}],
    status: 'active' | 'inactive' | 'skip',
    manager: string,
    notes: string
  }],
  checklists: {
    'versionId_day_1': [/* Monday tasks */],
    'versionId_day_4': [/* Thursday tasks */],
    'versionId_day_5': [/* Friday tasks */]
  },
  emails: {
    'versionId_day_1': { from, cc, subject, content }
  }
}
```

### Task/Checklist Item Structure

```javascript
{
  id: string,
  text: string,
  completed: boolean,
  completedAt: string,  // "YYYY-MM-DD HH:mm" or null
  taskStatus: 'pending' | 'in-progress' | 'completed' | null,
  cautions: string,     // Displayed in RED
  notes: string,        // Displayed in black
  link: string,
  image: string,        // Base64 encoded
  suggestTime: string,  // "HH:mm" format
  subtasks: [/* same structure */]
}
```

**Critical**: `cautions` and `notes` are separate fields with different display purposes. Do not confuse them.

### Key Application States

- `this.currentDay` - Currently selected maintenance day (1=Monday, 4=Thursday, 5=Friday)
- `this.selectedVersionId` - Currently selected version for detail view
- `this.fileSystemHandle` - Directory handle for File System Access API
- `this.expandedSubtasks` - Object tracking which subtask sections are expanded

## Critical Behaviors

### New Week Reset (`startNewWeek()`)

The "新的一周" (New Week) operation:
1. Creates automatic backup file: `log/new-week-backup-YYYY-MM-DD-HHMMSS.json`
2. Resets completed tasks to pending state
3. Preserves version numbers and checklist structure
4. Only affects tasks with `completed=true` and `taskStatus='completed'`
5. Tasks without taskStatus only have checkbox reset

**Important**: This does NOT automatically update version numbers (current → previous), despite original requirements.

### Task Completion Cascading

- Checking a parent task automatically checks all subtasks
- Unchecking a parent task unchecks all subtasks
- When all subtasks are completed, parent task auto-checks
- When any subtask is unchecked, parent task auto-unchecks

### Data Migration (`migrateData()`)

The app includes automatic migration logic:
- Old format: `notes` field → New format: `cautions` field
- Old format: `notes2` field → New format: `notes` field
- Old format: `link` string → New format: `links` array
- Runs on both file load and data import

### Backup Naming Convention

Automatic backups use timestamped filenames:
- New week: `new-week-backup-YYYY-MM-DD-HHMMSS.json`
- Import operation: `import-backup-YYYY-MM-DD-HHMMSS.json`
- Manual export: `version-maintenance-YYYY-MM-DD.json`

## Browser Compatibility

- **Primary**: Chrome/Edge 90+ (full File System Access API support)
- **Secondary**: Safari/Firefox (localStorage only, manual downloads)
- **Feature detection**: App automatically degrades gracefully

## Common Development Patterns

### Adding New Features

1. Add data field to relevant schema (version, task, or email)
2. Update migration logic if needed (`migrateData()`)
3. Add UI elements in `index.html` or generate dynamically in render methods
4. Add event handlers (inline `onclick` or in `bindEvents()`)
5. Update `saveData()` persistence logic
6. Test both localStorage and File System Access paths

### Modifying Render Methods

All render methods follow this pattern:
```javascript
renderXxx() {
  this.elements.xxxElement.innerHTML = `...template strings...`;
  // Bind events if needed
  this.bindXxxEvents();
}
```

After modifying data, always call `this.render()` for full refresh or specific render methods for partial updates.

### Modal Pattern

Modals use a consistent pattern:
1. `showModal(content)` - Displays modal with HTML content
2. `hideModal()` - Closes modal
3. Modal body content is set via `this.elements.modalBody.innerHTML`
4. Actions typically call `confirmXxx()` methods

### Toast Notifications

Use `this.showToast(message)` for user feedback. Toasts auto-dismiss after 3 seconds.

## Testing Notes

### Manual Testing Checklist

1. Add/edit/delete versions
2. Add/edit/delete tasks and subtasks
3. Toggle checkboxes and verify cascading behavior

4. Test "新的一周" reset and verify backup creation
5. Import/export data and verify integrity
6. Test email configuration (Monday view only)
7. Verify task status (pending/in-progress/completed) works correctly
8. Test image upload and display
9. Verify "未完成任务" panel filters correctly

### File System Access Testing

To test File System Access API:
1. Run via HTTP server (not file:// protocol)
2. Select project directory when prompted
3. Verify `data/data.json` is created/updated
4. Verify `log/` directory and backup files are created
5. Refresh page and verify data persists from file

### Known Limitations

- localStorage ~5MB limit (check if data grows large)
- File System Access API not available in all browsers
- No real-time collaboration features
- No version control/conflict resolution for concurrent edits
- Images stored as Base64 (can bloat data size)

## Recent Bug Fixes (From Git History)

1. **cautions/notes field confusion** - Fixed incorrect field assignment during import
2. **New week reset logic** - Distinguished between tasks with/without taskStatus
3. **Edit version modal** - Fixed modal not closing after save
4. **Button unresponsiveness** - Fixed JavaScript syntax errors
5. **Backup file naming** - Added prefixes to distinguish backup types
