import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { basenameSafe, formatShortcut, toPosixPath } from '@shared/platform'
import { SHORTCUT_MAP } from '@shared/shortcuts'
import { useAppStore } from '../../store/app-store'
import type { Tab } from '../../store/types'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './TabBar.module.css'

const TAB_ICONS: Record<Tab['type'], { icon: string; className: string }> = {
  terminal: { icon: '>_', className: styles.terminal },
  file: { icon: '◇', className: styles.file },
  diff: { icon: '±', className: styles.diff },
}

function getTabTitle(tab: Tab): string {
  if (tab.type === 'terminal') return tab.title
  if (tab.type === 'diff') return 'Changes'
  const name = basenameSafe(toPosixPath(tab.filePath)) || tab.filePath
  return name
}

export function TabBar() {
  const {
    activeTabId,
    setActiveTab,
    removeTab,
    activeWorkspaceTabs,
    createTerminalForActiveWorkspace,
    lastSavedTabId,
    settings,
    showConfirmDialog,
    dismissConfirmDialog,
  } = useAppStore(
    useShallow((s) => ({
      activeTabId: s.activeTabId,
      setActiveTab: s.setActiveTab,
      removeTab: s.removeTab,
      activeWorkspaceTabs: s.activeWorkspaceTabs,
      createTerminalForActiveWorkspace: s.createTerminalForActiveWorkspace,
      lastSavedTabId: s.lastSavedTabId,
      settings: s.settings,
      showConfirmDialog: s.showConfirmDialog,
      dismissConfirmDialog: s.dismissConfirmDialog,
    }))
  )
  const tabs = activeWorkspaceTabs()
  const confirmOnClose = settings.confirmOnClose

  const handleClose = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.stopPropagation()
      const tab = tabs.find((t) => t.id === tabId)
      if (!tab) return

      const closeTab = () => {
        if (tab.type === 'terminal') {
          window.api.pty.destroy(tab.ptyId)
        }
        removeTab(tabId)
      }

      if (tab.type === 'file' && tab.unsaved && confirmOnClose) {
        showConfirmDialog({
          title: 'Unsaved changes',
          message: `"${getTabTitle(tab)}" has unsaved changes. Close anyway?`,
          confirmLabel: 'Close',
          destructive: true,
          onConfirm: () => {
            closeTab()
            dismissConfirmDialog()
          },
        })
        return
      }

      closeTab()
    },
    [tabs, removeTab, confirmOnClose, showConfirmDialog, dismissConfirmDialog]
  )

  return (
    <div className={styles.tabBar}>
      <div className={styles.tabList}>
        {tabs.map((tab) => {
          const { icon, className } = TAB_ICONS[tab.type]
          const isSaved = tab.id === lastSavedTabId
          return (
            <div
              key={tab.id}
              className={`${styles.tab} ${tab.id === activeTabId ? styles.active : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className={`${styles.tabIcon} ${className}`}>{icon}</span>
              <span className={`${styles.tabTitle} ${isSaved ? styles.savedFlash : ''}`}>
                {getTabTitle(tab)}
              </span>
              {tab.type === 'file' && tab.unsaved ? (
                <span className={styles.unsavedDot} />
              ) : (
                <Tooltip
                  label="Close tab"
                  shortcut={formatShortcut(SHORTCUT_MAP.closeTab.mac, SHORTCUT_MAP.closeTab.win)}
                >
                  <button
                    aria-label={`Close ${getTabTitle(tab)}`}
                    className={styles.closeButton}
                    onClick={(e) => handleClose(e, tab.id)}
                  >
                    ✕
                  </button>
                </Tooltip>
              )}
            </div>
          )
        })}
      </div>

      <Tooltip
        label="New terminal"
        shortcut={formatShortcut(SHORTCUT_MAP.newTerminal.mac, SHORTCUT_MAP.newTerminal.win)}
      >
        <button
          aria-label="New terminal tab"
          className={styles.newTabButton}
          onClick={createTerminalForActiveWorkspace}
        >
          +
        </button>
      </Tooltip>

      <div className={styles.dragSpacer} />
    </div>
  )
}
