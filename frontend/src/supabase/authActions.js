export function authErrorMessage(error) {
  const code = error?.code;
  if (code === "invalid_credentials") return "Incorrect email or password. If signup failed earlier, choose Create an account and try again.";
  if (code === "email_not_confirmed") return "This account is awaiting email confirmation. Contact the project administrator if your confirmation email did not arrive.";
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit") return "Too many attempts. Wait a few minutes before trying again.";
  if (/error sending (confirmation|recovery|email)|smtp|gomail/i.test(error?.message || "")) {
    return "The email provider could not send this message. The project administrator needs to fix SMTP delivery.";
  }
  return error?.message || "Sign-in failed. Please try again.";
}

export async function authenticateWithEmail(auth, mode, values, redirectTo) {
  const credentials = { email: values.email.trim(), password: values.password };
  const response = mode === "register"
    ? await auth.signUp({ ...credentials, options: {
      data: { display_name: values.name.trim() }, emailRedirectTo: redirectTo,
    } })
    : await auth.signInWithPassword(credentials);
  if (response.error) throw new Error(authErrorMessage(response.error));
  if (mode !== "register" && !response.data?.session) {
    throw new Error("No login session was returned. Please try signing in again.");
  }
  return response.data;
}
