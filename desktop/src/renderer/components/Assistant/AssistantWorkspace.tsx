import { useMemo, useState } from 'react'
import { useAppStore } from '../../store/app-store'
import { AgentChatPanel } from '../RightPanel/AgentChatPanel'
import { FileTree } from '../RightPanel/FileTree'
import { ChangedFiles } from '../RightPanel/ChangedFiles'
import { TerminalPanel } from '../Terminal/TerminalPanel'
import styles from './AssistantWorkspace.module.css'

interface Props {
  workspaceId: string
  worktreePath: string
}

type DockMode = 'files' | 'changes'

export function AssistantWorkspace({ workspaceId, worktreePath }: Props) {
  const [dockMode, setDockMode] = useState<DockMode>('files')
  const {
    tabs,
    activeTabId,
    setActiveTab,
    createTerminalForActiveWorkspace,
    setRightPanelMode,
  } = useAppStore()

  const workspaceTerminals = useMemo(
    () =>
      tabs.filter(
        (tab): tab is Extract<typeof tab, { type: 'terminal' }> =>
          tab.workspaceId === workspaceId && tab.type === 'terminal',
      ),
    [tabs, workspaceId],
  )

  const selectedTerminal = useMemo(() => {
    const active = tabs.find((tab) => tab.id === activeTabId)
    if (active?.workspaceId === workspaceId && active.type === 'terminal') {
      return active
    }
    return workspaceTerminals[0] ?? null
  }, [tabs, activeTabId, workspaceId, workspaceTerminals])

  const openTerminalTab = async () => {
    if (selectedTerminal) {
      setActiveTab(selectedTerminal.id)
      setRightPanelMode('files')
      return
    }
    await createTerminalForActiveWorkspace()
    setRightPanelMode('files')
  }

  return (
    <div className={styles.layout}>
      <section className={styles.chatColumn}>
        <AgentChatPanel workspaceId={workspaceId} worktreePath={worktreePath} isActive={true} />
      </section>

      <aside className={styles.dockColumn}>
        <section className={styles.card}>
          <header className={styles.cardHeader}>
            <div className={styles.segmented}>
              <button
                className={`${styles.segmentButton} ${dockMode === 'files' ? styles.active : ''}`}
                onClick={() => setDockMode('files')}
              >
                Files
              </button>
              <button
                className={`${styles.segmentButton} ${dockMode === 'changes' ? styles.active : ''}`}
                onClick={() => setDockMode('changes')}
              >
                Changes
              </button>
            </div>
            <button className={styles.subtleButton} onClick={() => setRightPanelMode('files')}>
              Work view
            </button>
          </header>
          <div className={styles.cardBody}>
            {dockMode === 'files' ? (
              <FileTree worktreePath={worktreePath} isActive={true} />
            ) : (
              <ChangedFiles worktreePath={worktreePath} workspaceId={workspaceId} isActive={true} />
            )}
          </div>
        </section>

        <section className={styles.card}>
          <header className={styles.cardHeader}>
            <h3 className={styles.title}>Terminal</h3>
            <div className={styles.actions}>
              <button className={styles.subtleButton} onClick={() => void createTerminalForActiveWorkspace()}>
                New
              </button>
              <button className={styles.subtleButton} onClick={() => void openTerminalTab()}>
                Open tab
              </button>
            </div>
          </header>
          <div className={styles.terminalBody}>
            {selectedTerminal ? (
              <TerminalPanel ptyId={selectedTerminal.ptyId} active={true} />
            ) : (
              <div className={styles.emptyTerminal}>
                <p>No terminal in this workspace yet.</p>
                <button className={styles.primaryButton} onClick={() => void createTerminalForActiveWorkspace()}>
                  Create terminal
                </button>
              </div>
            )}
          </div>
        </section>
      </aside>
    </div>
  )
}

