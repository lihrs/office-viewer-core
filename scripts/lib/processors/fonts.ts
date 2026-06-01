/**
 * 字体处理器模块
 * 使用本地环境处理字体，无需 Docker 依赖
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Font, TTF } from "fonteditor-core";
import type { BuildConfig } from "../types.js";
import { logger } from "../logger.js";
import { ensureDir, copyDir } from "../fs-utils.js";

/** 字体样式索引 */
const FONT_STYLE_INDEX = {
  Regular: 0,
  Bold: 1,
  Italic: 2,
  BoldItalic: 3,
} as const;

/** 字体文件信息 */
interface FontFileInfo {
  /** 字体名称 */
  name: string;
  /** 字体文件名 */
  filename: string;
  /** 样式索引 */
  styleIndex: number;
  /** 文件索引（在 __fonts_files 中的位置） */
  fileIndex: number;
}

/** 字体家族信息 */
interface FontFamily {
  /** 字体名称 */
  name: string;
  /** Regular 样式文件索引 */
  regularIndex?: number;
  /** Bold 样式文件索引 */
  boldIndex?: number;
  /** Italic 样式文件索引 */
  italicIndex?: number;
  /** BoldItalic 样式文件索引 */
  boldItalicIndex?: number;
}

export class FontProcessor {
  private config: BuildConfig;
  private fontFiles: string[] = [];
  private fontFileInfos: FontFileInfo[] = [];

  constructor(config: BuildConfig) {
    this.config = config;
  }

  /** 检查是否有自定义字体 */
  hasFonts(): boolean {
    const { fonts } = this.config.paths;
    if (!fs.existsSync(fonts)) return false;

    const files = fs.readdirSync(fonts).filter((f) => {
      const ext = path.extname(f).toLowerCase();
      return ext === ".ttf" || ext === ".otf";
    });
    return files.length > 0;
  }

  /** 处理字体 */
  process(): boolean {
    const { paths } = this.config;

    if (!this.hasFonts()) {
      logger.info("fonts 目录为空，跳过字体处理");
      return true;
    }

    logger.info("开始处理字体...");

    try {
      // 1. 扫描字体文件
      this.scanFonts();

      if (this.fontFiles.length === 0) {
        logger.warn("未找到有效的字体文件");
        return true;
      }

      logger.info(`发现 ${this.fontFiles.length} 个字体文件`);

      // 2. 解析字体元数据
      this.parseFonts();

      // 3. 生成 AllFonts.js
      this.generateAllFontsJs();

      // 4. 复制字体文件
      this.copyFonts();

      logger.success("字体处理完成");
      return true;
    } catch (error) {
      logger.error(`字体处理失败: ${error}`);
      return false;
    }
  }

  /** 扫描字体目录 */
  private scanFonts(): void {
    const { fonts } = this.config.paths;
    const files = fs.readdirSync(fonts);

    this.fontFiles = files
      .filter((f) => {
        const ext = path.extname(f).toLowerCase();
        return ext === ".ttf" || ext === ".otf";
      })
      .sort()
      .map((f) => path.join(fonts, f));
  }

  /** 解析字体元数据 */
  private parseFonts(): void {
    this.fontFileInfos = [];

    for (let fileIndex = 0; fileIndex < this.fontFiles.length; fileIndex++) {
      const filePath = this.fontFiles[fileIndex];
      const filename = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase();

      try {
        const buffer = fs.readFileSync(filePath);
        const font = Font.create(buffer, {
          type: ext === ".otf" ? "otf" : "ttf",
        });

        const ttfData = font.get();
        const nameTable = (ttfData?.name || {}) as TTF.Name;
        const fontFamily = nameTable.fontFamily || this.extractFontName(filename);
        const fontSubfamily = nameTable.fontSubFamily || "Regular";

        const styleIndex = this.getStyleIndex(fontSubfamily, filename);

        this.fontFileInfos.push({
          name: fontFamily,
          filename,
          styleIndex,
          fileIndex,
        });

        logger.debug(`解析字体: ${fontFamily} (${fontSubfamily}) -> ${filename} [索引: ${fileIndex}, 样式: ${styleIndex}]`);
      } catch (error) {
        // 解析失败时，从文件名推断
        const fontName = this.extractFontName(filename);
        const styleIndex = this.getStyleIndex("", filename);

        this.fontFileInfos.push({
          name: fontName,
          filename,
          styleIndex,
          fileIndex,
        });

        logger.debug(`解析字体（从文件名推断）: ${fontName} -> ${filename} [索引: ${fileIndex}, 样式: ${styleIndex}]`);
      }
    }
  }

  /** 从文件名提取字体名称 */
  private extractFontName(filename: string): string {
    const baseName = path.basename(filename, path.extname(filename));
    // 移除常见的样式后缀
    return baseName
      .replace(/[-_](Bold|Italic|BoldItalic|Regular|Light|Medium|Semibold|Thin|Black)$/i, "")
      .replace(/[-_](BD|BI|IT|RG|LT|MT|SB|TH|BK)$/i, "")
      .replace(/[-_](Bd|Bi|It|Rg|Lt|Mt|Sb|Th|Bk)$/i, "");
  }

  /** 获取字体样式索引 */
  private getStyleIndex(subfamily: string, filename: string): number {
    const lowerSubfamily = subfamily.toLowerCase();
    const lowerFilename = filename.toLowerCase();

    const isBold =
      lowerSubfamily.includes("bold") ||
      lowerFilename.includes("bold") ||
      lowerFilename.includes("-bd") ||
      lowerFilename.includes("_bd") ||
      lowerFilename.endsWith("bd.ttf") ||
      lowerFilename.endsWith("bd.otf");

    const isItalic =
      lowerSubfamily.includes("italic") ||
      lowerSubfamily.includes("oblique") ||
      lowerFilename.includes("italic") ||
      lowerFilename.includes("oblique") ||
      lowerFilename.includes("-it") ||
      lowerFilename.includes("_it") ||
      lowerFilename.endsWith("it.ttf") ||
      lowerFilename.endsWith("it.otf");

    if (isBold && isItalic) return FONT_STYLE_INDEX.BoldItalic;
    if (isBold) return FONT_STYLE_INDEX.Bold;
    if (isItalic) return FONT_STYLE_INDEX.Italic;
    return FONT_STYLE_INDEX.Regular;
  }

  /** 按字体家族分组 */
  private groupFontsByFamily(): Map<string, FontFamily> {
    const families = new Map<string, FontFamily>();

    for (const font of this.fontFileInfos) {
      let family = families.get(font.name);
      if (!family) {
        family = { name: font.name };
        families.set(font.name, family);
      }

      // 根据样式索引分配文件索引
      switch (font.styleIndex) {
        case FONT_STYLE_INDEX.Regular:
          family.regularIndex = font.fileIndex;
          break;
        case FONT_STYLE_INDEX.Bold:
          family.boldIndex = font.fileIndex;
          break;
        case FONT_STYLE_INDEX.Italic:
          family.italicIndex = font.fileIndex;
          break;
        case FONT_STYLE_INDEX.BoldItalic:
          family.boldItalicIndex = font.fileIndex;
          break;
      }
    }

    return families;
  }

  /** 生成 AllFonts.js */
  private generateAllFontsJs(): void {
    const { paths } = this.config;
    const sdkjsCommonDir = path.join(paths.vendor, "sdkjs", "common");
    ensureDir(sdkjsCommonDir);

    // 生成 __fonts_files
    const fontsFiles = this.fontFileInfos.map((info) => `/fonts/${info.filename}`);

    // 按字体家族分组生成 __fonts_infos
    const families = this.groupFontsByFamily();
    const fontsInfos: (string | number)[][] = [];

    // 按字体名称排序
    const sortedFamilyNames = Array.from(families.keys()).sort();

    for (const familyName of sortedFamilyNames) {
      const family = families.get(familyName)!;
      // 格式: [名称, regular索引, 0, italic索引, 0, bold索引, 0, bolditalic索引, 0]
      fontsInfos.push([
        family.name,
        family.regularIndex ?? -1,
        0,
        family.italicIndex ?? -1,
        0,
        family.boldIndex ?? -1,
        0,
        family.boldItalicIndex ?? -1,
        0,
      ]);
    }

    const content = `window["__all_fonts_js_version__"] = 2;

window["__fonts_files"] = ${JSON.stringify(fontsFiles, null, 2)};

window["__fonts_infos"] = ${JSON.stringify(fontsInfos, null, 2)};
`;

    const outputPath = path.join(sdkjsCommonDir, "AllFonts.js");
    fs.writeFileSync(outputPath, content, "utf-8");
    logger.debug(`已生成: AllFonts.js (${this.fontFiles.length} 个字体文件, ${families.size} 个字体家族)`);
  }

  /** 复制字体文件 */
  private copyFonts(): void {
    const { paths } = this.config;
    const fontsTarget = path.join(paths.vendor, "fonts");
    ensureDir(fontsTarget);

    // 直接复制整个 fonts 目录
    copyDir(paths.fonts, fontsTarget);
    logger.debug(`已复制字体文件到: ${fontsTarget}`);
  }
}
