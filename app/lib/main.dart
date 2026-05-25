import 'package:flutter/material.dart';

import 'src/api_client.dart';
import 'src/config.dart';
import 'src/home_screen.dart';
import 'package:argus_security/argus_security.dart';

void main() {
  runApp(ArgusApp(api: ApiClient(baseUrl: defaultApiBase()), security: SecurityBridge()));
}

class ArgusApp extends StatelessWidget {
  const ArgusApp({super.key, required this.api, required this.security});

  final ApiClient api;
  final SecurityBridge security;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Argus',
      theme: ThemeData(colorSchemeSeed: const Color(0xFF1F5FBF), useMaterial3: true),
      home: HomeScreen(api: api, security: security),
    );
  }
}
