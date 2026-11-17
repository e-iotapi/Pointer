import 'package:cgpa_calculator/admin/gate_switch.dart';
import 'package:cgpa_calculator/admin/open_as.dart';
import 'package:cgpa_calculator/admin/widgets.dart';
import 'package:cgpa_calculator/app/theme/palette.dart';
import 'package:cgpa_calculator/app/theme/tokens.dart';
import 'package:cgpa_calculator/core/roles/roles.dart';
import 'package:cgpa_calculator/core/roles/session.dart';
import 'package:cgpa_calculator/features/reviews/gate_ui.dart';
import 'package:cgpa_calculator/features/setup/campus_pick_page.dart';
import 'package:cgpa_calculator/shared/widgets/app_card.dart';
import 'package:cgpa_calculator/shared/widgets/card_row.dart';
import 'package:cgpa_calculator/shared/widgets/count_badge.dart';
import 'package:cgpa_calculator/shared/widgets/page_header.dart';
import 'package:flutter/material.dart';

/// Board `Rl_Reviews`: Controls › Reviews. Campus pills, then one group:
/// review moderation (department, then its queue) and the compulsory-reviews
/// switch page for the picked campus, with its ON/OFF state.
class ReviewsToolsPage extends StatefulWidget {
  const ReviewsToolsPage({super.key});

  @override
  State<ReviewsToolsPage> createState() => _ReviewsToolsPageState();
}

class _ReviewsToolsPageState extends State<ReviewsToolsPage> {
  String _campus = viewCampus() ?? 'goa';

  Future<void> _push(Widget page) async {
    await Navigator.of(
      context,
    ).push(MaterialPageRoute<void>(builder: (_) => page));
    // The switch page may have turned the gate on or off.
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final p = AppPalette.of(context);
    return PageFrame(
      header: const PageHeader(eyebrow: 'CONTROLS · REVIEWS', title: 'Reviews'),
      children: [
        if (myRoles.value.owner)
          CampusPills(
            campus: _campus,
            onSelected: (c) => setState(() => _campus = c),
          )
        else
          SectionLabel(campusName(_campus)),
        const SizedBox(height: Space.sm),
        AppCard(
          padding: EdgeInsets.zero,
          child: Column(
            children: [
              CardRow(
                leading: IconTile(Icons.rate_review_outlined),
                title: 'Review moderation',
                subtitle: 'Pick a department, then its queue',
                minHeight: 58,
                onTap:
                    () => _push(
                      ViewAsDeptPage(
                        tools: true,
                        reviews: true,
                        campus: _campus,
                      ),
                    ),
              ),
              const CardDivider(),
              CardRow(
                leading: IconTile(Icons.lock_outline_rounded),
                title: 'Compulsory reviews',
                subtitle: 'Lock reviews until electives are reviewed',
                minHeight: 58,
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    FutureBuilder<GateInfo?>(
                      key: ValueKey(_campus),
                      future: roleStore == null ? null : gateInfo(_campus),
                      initialData: peekGateInfo(_campus),
                      builder: (_, snap) {
                        final on = snap.data?.on;
                        if (on == null) return const SizedBox.shrink();
                        return on
                            ? const CountBadge('ON', tone: CountTone.on)
                            : const CountBadge('OFF', tone: CountTone.neutral);
                      },
                    ),
                    Icon(Icons.chevron_right_rounded, color: p.textMuted),
                  ],
                ),
                onTap: () => _push(GateSwitchPage(campus: _campus)),
              ),
            ],
          ),
        ),
        const Note(
          'Moderation hides or restores a review and is logged with your name. '
          'Compulsory reviews applies to the whole campus.',
        ),
      ],
    );
  }
}
