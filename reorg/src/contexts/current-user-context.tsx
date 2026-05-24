"use client";

import { createContext, useContext, type ReactNode } from "react";

export type CurrentUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  helpdeskOrderActionsEnabled?: boolean;
};

const CurrentUserContext = createContext<CurrentUser | null>(null);

export function CurrentUserProvider({
  children,
  user,
}: {
  children: ReactNode;
  user: CurrentUser | null;
}) {
  return (
    <CurrentUserContext.Provider value={user}>
      {children}
    </CurrentUserContext.Provider>
  );
}

export function useCurrentUser() {
  return useContext(CurrentUserContext);
}
