import 'package:cgpa_calculator/admin/gate_switch.dart';
import 'package:cgpa_calculator/admin/open_as.dart';
import 'package:cgpa_calculator/admin/widgets.dart';
import 'package:cgpa_calculator/app/theme/tokens.dart';
import 'package:cgpa_calculator/features/setup/campus_pick_page.dart';
import 'package:cgpa_calculator/shared/widgets/app_card.dart';
import 'package:cgpa_calculator/shared/widgets/card_row.dart';
import 'package:cgpa_calculator/shared/widgets/page_header.dart';
import 'package:flutter/material.dart';

/// Board `Rl_Reviews`: Controls › Reviews. Campus pills, then review
/// moderation (campus, department, its queue) and the compulsory-reviews
/// switch for the picked campus.
class ReviewsToolsPage extends StatefulWidget {
  const ReviewsToolsPage({super.key});

  @override
  State<ReviewsToolsPage> createState() => _ReviewsToolsPageState();
}

class _ReviewsToolsPageState extends State<ReviewsToolsPage> {
  String _campus = viewCampus() ?? 'goa';

  @override
  Widget build(BuildContext context) => PageFrame(
    header: const PageHeader(eyebrow: 'CONTROLS · REVIEWS', title: 'Reviews'),
    children: [
      CampusPills(
        campus: _campus,
        onSelected: (c) => setState(() => _campus = c),
      ),
      const SizedBox(height: Space.sm),
      AppCard(
        padding: EdgeInsets.zero,
        child: CardRow(
          leading: IconTile(Icons.rate_review_outlined),
          title: 'Review moderation',
          subtitle: 'Pick a department, then its queue',
          minHeight: 58,
          onTap:
              () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder:
                      (_) => ViewAsDeptPage(
                        tools: true,
                        reviews: true,
                        campus: _campus,
                      ),
                ),
              ),
        ),
      ),
      const SizedBox(height: Space.sm),
      GateSwitchRow(key: ValueKey(_campus), campus: _campus, pills: false),
      const Note(
        'Moderation hides or restores a review and is logged with your name. '
        'Compulsory reviews applies to the whole campus.',
      ),
    ],
  );
}
