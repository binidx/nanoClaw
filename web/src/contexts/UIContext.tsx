import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { useMobileDetect } from '../hooks/useMobileDetect';
import {
  applyThemeToDocument,
  resolveInitialTheme,
  THEME_STORAGE_KEY,
  type ThemeMode,
} from '../theme';
import type { ConfirmDialogState, Conversation } from '../app-types';

export type SettingsPageTarget = 'default-access-policy' | null;

export type RenameDialogState = {
  open: boolean;
  conversation: Conversation | null;
  value: string;
  saving: boolean;
};

interface UIContextValue {
  theme: ThemeMode;
  setTheme: React.Dispatch<React.SetStateAction<ThemeMode>>;
  toggleTheme: () => void;

  conversationSidebarCollapsed: boolean;
  setConversationSidebarCollapsed: React.Dispatch<
    React.SetStateAction<boolean>
  >;
  toggleConversationSidebar: () => void;

  isMobile: boolean;
  mobileConvDrawerOpen: boolean;
  setMobileConvDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  toggleMobileConvDrawer: () => void;

  confirmDialog: ConfirmDialogState;
  setConfirmDialog: React.Dispatch<React.SetStateAction<ConfirmDialogState>>;

  renameDialog: RenameDialogState;
  setRenameDialog: React.Dispatch<React.SetStateAction<RenameDialogState>>;

  shareDialogUrl: string | null;
  setShareDialogUrl: React.Dispatch<React.SetStateAction<string | null>>;

  assistantPageTargetId: string | null;
  setAssistantPageTargetId: React.Dispatch<
    React.SetStateAction<string | null>
  >;

  settingsPageTarget: SettingsPageTarget;
  setSettingsPageTarget: React.Dispatch<
    React.SetStateAction<SettingsPageTarget>
  >;

  copied: boolean;
  setCopied: React.Dispatch<React.SetStateAction<boolean>>;
}

const UIContext = createContext<UIContextValue | null>(null);

const INITIAL_RENAME_DIALOG: RenameDialogState = {
  open: false,
  conversation: null,
  value: '',
  saving: false,
};

export function UIProvider({ children }: { children: ReactNode }) {
  const [assistantPageTargetId, setAssistantPageTargetId] = useState<
    string | null
  >(null);
  const [settingsPageTarget, setSettingsPageTarget] =
    useState<SettingsPageTarget>(null);

  const [conversationSidebarCollapsed, setConversationSidebarCollapsed] =
    useState(false);

  const isMobile = useMobileDetect();
  const [mobileConvDrawerOpen, setMobileConvDrawerOpen] = useState(false);
  const toggleMobileConvDrawer = useCallback(
    () => setMobileConvDrawerOpen((prev) => !prev),
    [],
  );

  const [theme, setTheme] = useState<ThemeMode>(resolveInitialTheme);

  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    open: false,
    title: '',
    message: '',
  });

  const [renameDialog, setRenameDialog] = useState<RenameDialogState>(
    INITIAL_RENAME_DIALOG,
  );

  const [shareDialogUrl, setShareDialogUrl] = useState<string | null>(null);

  const [copied, setCopied] = useState(false);

  const toggleTheme = useCallback(
    () => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark')),
    [],
  );

  const toggleConversationSidebar = useCallback(() => {
    setConversationSidebarCollapsed((prev) => !prev);
  }, []);

  useEffect(() => {
    applyThemeToDocument(document, theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const value: UIContextValue = {
    theme,
    setTheme,
    toggleTheme,
    conversationSidebarCollapsed,
    setConversationSidebarCollapsed,
    toggleConversationSidebar,
    isMobile,
    mobileConvDrawerOpen,
    setMobileConvDrawerOpen,
    toggleMobileConvDrawer,
    confirmDialog,
    setConfirmDialog,
    renameDialog,
    setRenameDialog,
    shareDialogUrl,
    setShareDialogUrl,
    assistantPageTargetId,
    setAssistantPageTargetId,
    settingsPageTarget,
    setSettingsPageTarget,
    copied,
    setCopied,
  };

  return (
    <UIContext.Provider value={value}>{children}</UIContext.Provider>
  );
}

export function useUI(): UIContextValue {
  const ctx = useContext(UIContext);
  if (!ctx) throw new Error('useUI must be used within UIProvider');
  return ctx;
}
