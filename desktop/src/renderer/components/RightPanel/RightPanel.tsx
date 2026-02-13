import { formatShortcut } from '@shared/platform'
import { SHORTCUT_MAP } from '@shared/shortcuts'
import { useAppStore } from '../../store/app-store'
import { FileTree } from './FileTree'
import { ChangedFiles } from './ChangedFiles'
import { AgentChatPanel } from './AgentChatPanel'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './RightPanel.module.css'

export function RightPanel() {
  const { rightPanelMode, setRightPanelMode, activeWorkspaceId, workspaces } = useAppStore()

  const workspace = workspaces.find((w) => w.id === activeWorkspaceId)

  return (
    <div className={styles.rightPanel}>
      <div className={styles.header}>
        <div className={styles.modeToggle}>
          <Tooltip
            label="Files"
            shortcut={formatShortcut(SHORTCUT_MAP.filesPanel.mac, SHORTCUT_MAP.filesPanel.win)}
          >
            <button
              className={`${styles.modeButton} ${rightPanelMode === 'files' ? styles.active : ''}`}
              onClick={() => setRightPanelMode('files')}
            >
              Files
            </button>
          </Tooltip>
          <Tooltip
            label="Changes"
            shortcut={formatShortcut(SHORTCUT_MAP.changesPanel.mac, SHORTCUT_MAP.changesPanel.win)}
          >
            <button
              className={`${styles.modeButton} ${rightPanelMode === 'changes' ? styles.active : ''}`}
              onClick={() => setRightPanelMode('changes')}
            >
              Changes
            </button>
          </Tooltip>
          <Tooltip label="Chat">
            <button
              className={`${styles.modeButton} ${rightPanelMode === 'assistant' ? styles.active : ''}`}
              onClick={() => setRightPanelMode('assistant')}
            >
              Chat
            </button>
          </Tooltip>
        </div>
      </div>

      <div className={styles.content}>
        {!workspace ? (
          <div className={styles.emptyState}>
            <span className={styles.emptyIcon}>📁</span>
            <span className={styles.emptyText}>
              Select a workspace to browse files
            </span>
          </div>
        ) : (
          <>
            <div style={{ display: rightPanelMode === 'files' ? 'contents' : 'none' }}>
              <FileTree worktreePath={workspace.worktreePath} isActive={rightPanelMode === 'files'} />
            </div>
            <div style={{ display: rightPanelMode === 'changes' ? 'contents' : 'none' }}>
              <ChangedFiles
                worktreePath={workspace.worktreePath}
                workspaceId={workspace.id}
                isActive={rightPanelMode === 'changes'}
              />
            </div>
            <div style={{ display: rightPanelMode === 'assistant' ? 'contents' : 'none' }}>
              <AgentChatPanel
                workspaceId={workspace.id}
                worktreePath={workspace.worktreePath}
                isActive={rightPanelMode === 'assistant'}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
