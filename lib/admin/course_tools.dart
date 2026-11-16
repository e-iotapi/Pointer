import 'package:cgpa_calculator/admin/bulk_upload.dart';
import 'package:cgpa_calculator/admin/maintain.dart';
import 'package:cgpa_calculator/admin/open_as.dart';
import 'package:cgpa_calculator/admin/professors.dart';
import 'package:cgpa_calculator/admin/widgets.dart';
import 'package:cgpa_calculator/app/theme/tokens.dart';
import 'package:cgpa_calculator/core/platform/browser.dart';
import 'package:cgpa_calculator/core/roles/roles.dart';
import 'package:cgpa_calculator/features/setup/campus_pick_page.dart';
import 'package:cgpa_calculator/shared/widgets/app_card.dart';
import 'package:cgpa_calculator/shared/widgets/card_row.dart';
import 'package:cgpa_calculator/shared/widgets/page_header.dart';
import 'package:flutter/material.dart';

/// Board `Rl_CourseTools`: Controls › Course tools. Campus pills, then the
/// department and course screens a president or CR uses, professor merge and
/// the JSON bulk upload. Nothing here sets Open as; saves are the signed-in
/// person's and logged with their name.
class CourseToolsPage extends StatefulWidget {
  const CourseToolsPage({super.key});

  @override
  State<CourseToolsPage> createState() => _CourseToolsPageState();
}

class _CourseToolsPageState extends State<CourseToolsPage> {
  String _campus = viewCampus() ?? 'goa';

  void _push(Widget page) =>
      Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page));

  @override
  Widget build(BuildContext context) => PageFrame(
    header: const PageHeader(
      eyebrow: 'CONTROLS · COURSE TOOLS',
      title: 'Course tools',
    ),
    children: [
      CampusPills(
        campus: _campus,
        onSelected: (c) => setState(() => _campus = c),
      ),
      const SizedBox(height: Space.sm),
      AppCard(
        padding: EdgeInsets.zero,
        child: Column(
          children: [
            CardRow(
              leading: IconTile(Icons.account_tree_outlined),
              title: 'By department',
              subtitle:
                  'Courses & schemes, degree requirements, professors, '
                  'resources, contributor approvals',
              titleLines: 2,
              minHeight: 58,
              onTap: () => _push(ViewAsDeptPage(tools: true, campus: _campus)),
            ),
            const CardDivider(),
            CardRow(
              leading: IconTile(Icons.menu_book_outlined),
              title: 'By course',
              subtitle: 'Structure, averages and resources for one course',
              minHeight: 58,
              onTap:
                  () => _push(ViewAsCoursePage(tools: true, campus: _campus)),
            ),
            const CardDivider(),
            CardRow(
              leading: IconTile(Icons.merge_type_rounded),
              title: 'Merge professors',
              subtitle: 'Two entries for one person',
              minHeight: 58,
              onTap: () => _push(ProfessorMerge(campus: _campus)),
            ),
            const CardDivider(),
            CardRow(
              leading: IconTile(Icons.upload_file_rounded),
              title: 'Bulk upload',
              subtitle: 'Eval schemes from a JSON file',
              minHeight: 58,
              onTap: () => _push(_BulkUpload(campus: _campus)),
            ),
          ],
        ),
      ),
      const Note(
        'By department opens the same department screen a president uses, '
        'without its Reviews tile; By course opens the CR\'s course screen. '
        'Saves are yours and logged with your name.',
      ),
      const Note(
        'Someone with a custom role sees only the rows their role allows, '
        'for the department or campus the role covers.',
      ),
    ],
  );
}

/// The file or paste drop zone for [campus], then the preview page.
class _BulkUpload extends StatelessWidget {
  const _BulkUpload({required this.campus});
  final String campus;

  @override
  Widget build(BuildContext context) {
    Future<void> upload(String? source) async {
      if (source == null || !context.mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => BulkUploadPage(campus: campus, source: source),
        ),
      );
    }

    return PageFrame(
      header: PageHeader(
        eyebrow: 'COURSE TOOLS · ${campusName(campus).toUpperCase()}',
        title: 'Bulk upload',
      ),
      children: [
        DropZone(
          onFile:
              () async => upload(await pickTextFile('.json,application/json')),
          onPaste:
              () async => upload(
                await pasteJson(context, '{"schema":"pointer.eval.v1", …}'),
              ),
        ),
        const SizedBox(height: Space.sm),
        const UploadCard(),
      ],
    );
  }
}
