import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { isAdminEmail } from "@/lib/app-env";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const email = String(credentials.email).trim().toLowerCase();

        const user = await db.user.findUnique({
          where: { email },
        });

        if (!user || !user.passwordHash) return null;

        const isValid = await bcrypt.compare(
          String(credentials.password),
          user.passwordHash
        );

        if (!isValid) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      const email = user.email?.trim().toLowerCase();
      if (!email) return false;

      const existingUser = await db.user.findUnique({
        where: { email },
      });

      if (!existingUser && !isAdminEmail(email)) {
        return false;
      }

      const ensuredUser = await db.user.upsert({
        where: { email },
        create: {
          email,
          name: user.name ?? email,
          role: isAdminEmail(email) ? "ADMIN" : "OPERATOR",
        },
        update: {
          ...(user.name ? { name: user.name } : {}),
          ...(isAdminEmail(email) ? { role: "ADMIN" } : {}),
        },
      });

      (user as { id?: string }).id = ensuredUser.id;

      await db.auditLog.create({
        data: {
          userId: ensuredUser.id,
          action: "sign_in",
          entityType: "user",
          entityId: ensuredUser.id,
          details: {
            email,
          },
        },
      }).catch(() => {});

      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        token.role = isAdminEmail(user.email)
          ? "ADMIN"
          : (user as { role?: string }).role ?? "OPERATOR";
        token.id = user.id!;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        (session.user as { role: string }).role = token.role as string;
      }
      return session;
    },
  },
  events: {
    async signOut(message) {
      const token = "token" in message ? message.token : null;
      await db.auditLog.create({
        data: {
          userId: typeof token?.id === "string" ? token.id : undefined,
          action: "sign_out",
          entityType: "user",
          entityId: typeof token?.id === "string" ? token.id : undefined,
          details: {},
        },
      }).catch(() => {});
    },
  },
});
