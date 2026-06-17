import 'package:argus_security/argus_security.dart';
import 'package:flutter/material.dart';

import 'src/api_client.dart';
import 'src/auth_controller.dart';
import 'src/config.dart';
import 'src/home_screen.dart';
import 'src/screens/login_screen.dart';
import 'src/screens/policy_screen.dart';
import 'src/theme.dart';

void main() {
  final security = SecurityBridge();
  final api = ApiClient(baseUrl: defaultApiBase(), security: security, store: SecureTokenStore());
  runApp(ArgusApp(auth: AuthController(api)..start(), security: security));
}

class ArgusApp extends StatelessWidget {
  const ArgusApp({super.key, required this.auth, required this.security});

  final AuthController auth;
  final SecurityBridge security;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Argus',
      debugShowCheckedModeBanner: false,
      theme: argusTheme(),
      home: ListenableBuilder(
        listenable: auth,
        builder: (context, _) => switch (auth.status) {
          AuthStatus.loading => const Scaffold(body: Center(child: CircularProgressIndicator())),
          AuthStatus.signedOut => LoginScreen(auth: auth),
          AuthStatus.needsPolicy => PolicyScreen(auth: auth),
          AuthStatus.signedIn => HomeScreen(auth: auth, security: security),
        },
      ),
    );
  }
}
