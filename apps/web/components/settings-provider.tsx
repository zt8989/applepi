'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { SettingsModal } from './settings-modal';

const Ctx = createContext<{ open: () => void }>({ open: () => {} });

/** Open the settings modal from anywhere (sidebar, etc.). */
export function useSettings() {
  return useContext(Ctx);
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [openState, setOpenState] = useState(false);
  return (
    <Ctx.Provider value={{ open: () => setOpenState(true) }}>
      {children}
      <SettingsModal open={openState} onClose={() => setOpenState(false)} />
    </Ctx.Provider>
  );
}
