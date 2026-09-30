import test from "node:test";
import assert from "node:assert/strict";
import { authenticateWithEmail, authErrorMessage } from "../src/supabase/authActions.js";

test("password login preserves existing passwords and normalizes email whitespace", async () => {
  const session = { access_token: "test-session", user: { id: "user" } };
  const auth = { signInWithPassword: async (input) => {
    assert.deepEqual(input, { email: "user@example.com", password: "sixchr" });
    return { data: { session }, error: null };
  } };
  assert.equal((await authenticateWithEmail(auth, "login", { email: " user@example.com ", password: "sixchr" })).session, session);
});

test("registration supports both immediate Supabase sessions and email confirmation", async () => {
  for (const session of [null, { user: { id: "cloud-user" } }]) {
    const auth = { signUp: async (input) => {
      assert.equal(input.options.data.display_name, "Demo");
      assert.equal(input.options.emailRedirectTo, "http://localhost:5173/");
      return { data: { session }, error: null };
    } };
    assert.equal((await authenticateWithEmail(auth, "register", {
      email: "user@example.com", password: "password-123", name: " Demo ",
    }, "http://localhost:5173/")).session, session);
  }
});

test("login never treats missing sessions or rejected credentials as success", async () => {
  const values = { email: "user@example.com", password: "password-123" };
  await assert.rejects(authenticateWithEmail({ signInWithPassword: async () => ({ data: {} }) }, "login", values), /No login session/);
  await assert.rejects(authenticateWithEmail({ signInWithPassword: async () => ({ error: { code: "invalid_credentials" } }) }, "login", values), /Incorrect email or password/);
  assert.match(authErrorMessage({ message: "Error sending confirmation email" }), /fix SMTP/);
});
