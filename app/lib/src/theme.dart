import 'package:flutter/material.dart';

/// Heimdall-style dark theme: near-black surfaces, thin grey borders, large
/// radii and a green accent. Shared with the web app's CSS tokens.
class ArgusColors {
  static const bg = Color(0xFF0B0C0E);
  static const surface = Color(0xFF101114);
  static const surface2 = Color(0xFF16181B);
  static const line = Color(0xFF26282C);
  static const lineStrong = Color(0xFF34373C);
  static const fg = Color(0xFFF4F5F6);
  static const fg2 = Color(0xFFA3A8AE);
  static const fg3 = Color(0xFF7B8087);
  static const accent = Color(0xFF34C77B);
  static const accentInk = Color(0xFF06140D);
  static const accentTile = Color(0xFF0F3A2B);
  static const warn = Color(0xFFF5B04C);
  static const warnTile = Color(0xFF3A2A0F);
  static const bad = Color(0xFFF06A5F);
  static const badTile = Color(0xFF3A1512);
  static const brandA = Color(0xFFFF7A45);
  static const brandB = Color(0xFFE8452C);
}

ThemeData argusTheme() {
  final scheme = const ColorScheme.dark(
    primary: ArgusColors.accent,
    onPrimary: ArgusColors.accentInk,
    secondary: ArgusColors.accent,
    surface: ArgusColors.surface,
    onSurface: ArgusColors.fg,
    error: ArgusColors.bad,
    outline: ArgusColors.lineStrong,
    outlineVariant: ArgusColors.line,
  );
  final base = ThemeData(useMaterial3: true, colorScheme: scheme, brightness: Brightness.dark);
  final text = base.textTheme.apply(bodyColor: ArgusColors.fg, displayColor: ArgusColors.fg);
  final radius = BorderRadius.circular(12);
  return base.copyWith(
    scaffoldBackgroundColor: ArgusColors.bg,
    textTheme: text.copyWith(
      headlineSmall: text.headlineSmall?.copyWith(fontWeight: FontWeight.w700, letterSpacing: -0.2),
      titleLarge: text.titleLarge?.copyWith(fontWeight: FontWeight.w700),
      titleMedium: text.titleMedium?.copyWith(fontWeight: FontWeight.w600),
      bodyMedium: text.bodyMedium?.copyWith(color: ArgusColors.fg2),
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: ArgusColors.bg,
      foregroundColor: ArgusColors.fg,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
    ),
    cardTheme: CardThemeData(
      color: ArgusColors.surface,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20), side: const BorderSide(color: ArgusColors.line)),
    ),
    dividerTheme: const DividerThemeData(color: ArgusColors.line, space: 1, thickness: 1),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: ArgusColors.accent,
        foregroundColor: ArgusColors.accentInk,
        minimumSize: const Size.fromHeight(52),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
        shape: RoundedRectangleBorder(borderRadius: radius),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: ArgusColors.fg,
        minimumSize: const Size.fromHeight(48),
        side: const BorderSide(color: ArgusColors.lineStrong),
        shape: RoundedRectangleBorder(borderRadius: radius),
      ),
    ),
    textButtonTheme: TextButtonThemeData(style: TextButton.styleFrom(foregroundColor: ArgusColors.accent)),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: ArgusColors.surface2,
      labelStyle: const TextStyle(color: ArgusColors.fg2),
      hintStyle: const TextStyle(color: ArgusColors.fg3),
      border: OutlineInputBorder(borderRadius: radius, borderSide: const BorderSide(color: ArgusColors.lineStrong)),
      enabledBorder: OutlineInputBorder(borderRadius: radius, borderSide: const BorderSide(color: ArgusColors.lineStrong)),
      focusedBorder: OutlineInputBorder(borderRadius: radius, borderSide: const BorderSide(color: ArgusColors.accent, width: 1.5)),
    ),
    snackBarTheme: const SnackBarThemeData(backgroundColor: ArgusColors.surface2, contentTextStyle: TextStyle(color: ArgusColors.fg)),
  );
}

/// Rounded square with a green (or warn/bad) line icon, as in Heimdall.
class IconTile extends StatelessWidget {
  const IconTile(this.icon, {super.key, this.tone = TileTone.good, this.size = 44});

  final IconData icon;
  final TileTone tone;
  final double size;

  @override
  Widget build(BuildContext context) {
    final (bg, fg) = switch (tone) {
      TileTone.good => (ArgusColors.accentTile, ArgusColors.accent),
      TileTone.warn => (ArgusColors.warnTile, ArgusColors.warn),
      TileTone.bad => (ArgusColors.badTile, ArgusColors.bad),
    };
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(10)),
      child: Icon(icon, color: fg, size: size * 0.5),
    );
  }
}

enum TileTone { good, warn, bad }

/// The Argus wordmark with the orange brand tile.
class ArgusWordmark extends StatelessWidget {
  const ArgusWordmark({super.key, this.size = 28});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: size + 8,
          height: size + 8,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(9),
            gradient: const LinearGradient(colors: [ArgusColors.brandA, ArgusColors.brandB], begin: Alignment.topLeft, end: Alignment.bottomRight),
          ),
          alignment: Alignment.center,
          child: Text('A', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: size * 0.7)),
        ),
        const SizedBox(width: 12),
        Text('ARGUS', style: TextStyle(fontSize: size, fontWeight: FontWeight.w800, letterSpacing: size * 0.15, color: ArgusColors.fg)),
      ],
    );
  }
}
