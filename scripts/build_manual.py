"""Generate the offline HTML manual and its printable Chinese PDF."""
import argparse
import html
import json
import os
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parents[1]


def build_independence():
    source=(ROOT/'INDEPENDENT_IMPLEMENTATION.txt').read_text('utf-8')
    blocks=source.strip().split('\n\n');parts=[]
    for i,block in enumerate(blocks):
        if i==0: parts.append('<h1>'+html.escape(block.splitlines()[0])+'</h1><p>'+html.escape(' '.join(block.splitlines()[1:]))+'</p>')
        elif '\n' not in block and len(block)<25: parts.append('<h2>'+html.escape(block)+'</h2>')
        else:
            text=html.escape(block)
            text=re.sub(r'https://[^\s]+',lambda m:'<a href="'+m[0]+'" target="_blank" rel="noopener">'+m[0]+'</a>',text)
            parts.append('<p>'+text.replace('\n','<br>')+'</p>')
    css='body{font:15px/1.9 "Microsoft YaHei","Segoe UI",sans-serif;color:#24394a;background:#edf2f5;margin:0}main{max-width:900px;margin:30px auto;padding:32px 44px;background:white;border:1px solid #d3dfe8;border-radius:12px}h1{font-size:26px;color:#154462}h2{font-size:18px;margin-top:30px;color:#216276}a{color:#226d9f;overflow-wrap:anywhere}p{overflow-wrap:anywhere}@media(max-width:700px){main{margin:12px;padding:20px}h1{font-size:22px}}'
    (ROOT/'viewer/web/independence.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ORS Viewer 独立实现说明</title><style>'+css+'</style><main><a href="/">返回查看器</a>'+''.join(parts)+'</main></html>',encoding='utf-8',newline='\n')


def build_html(book):
    esc = html.escape
    css = '''*{box-sizing:border-box}body{margin:0;color:#233344;background:#f0f4f5;font:15px/1.85 "Microsoft YaHei","Noto Sans CJK SC",sans-serif}header{background:#102834;color:#fff;padding:26px max(24px,calc((100vw - 980px)/2));display:flex;align-items:center;justify-content:space-between;gap:20px}header h1{margin:0;font-size:24px}header small{color:#9ac9c1}a{color:#08776d}header a{color:#b9fff0;white-space:nowrap}nav{max-width:980px;margin:28px auto;background:#fff;border:1px solid #d6e2e5;border-radius:12px;padding:22px 32px;display:grid;grid-template-columns:repeat(2,1fr);gap:7px 24px}main{max-width:980px;margin:auto}article{background:white;padding:34px 46px;margin-bottom:26px;border-radius:12px;border:1px solid #d6e2e5}h2{font-size:26px;margin:0 0 12px;color:#123f4c}h3{font-size:18px;margin:25px 0 9px;color:#16635f}.lead{color:#59717a;font-size:16px}li{padding-left:3px;margin:7px 0}table{width:100%;border-collapse:collapse;margin:12px 0 18px}th{background:#164c54;color:#fff;text-align:left}td,th{padding:10px 14px;border:1px solid #d8e4e7;vertical-align:top}tr:nth-child(even){background:#f5f9fa}td:first-child{width:30%}.note{border-left:4px solid #3aa58e;background:#edf8f4;padding:12px 17px;margin:22px 0 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf2f5;border:1px solid #d7e2e6;border-radius:7px;padding:16px;font:13px/1.8 Consolas,monospace}.layout{display:grid;grid-template-columns:1fr 2fr 1.2fr;gap:10px;margin:18px 0}.layout div{padding:24px 10px;background:#eaf3f4;border:1px solid #b7d6da;border-radius:7px;text-align:center}.layout strong{display:block}.layout span{font-size:12px;color:#4f737a}footer{text-align:center;color:#617b83;padding:15px 20px 40px}@media(max-width:700px){header{display:block;padding:20px}nav{grid-template-columns:1fr;margin:15px}article{padding:25px 22px;margin:15px}h2{font-size:22px}td,th{padding:8px}.layout{gap:5px}.layout div{padding:14px 4px}}@media print{body{background:white;font-size:10pt}header,nav,.download,footer{display:none}article{page-break-after:always;border:0;margin:0;padding:0}article:last-child{page-break-after:auto}h2,h3{page-break-after:avoid}table,.note,pre{break-inside:avoid}@page{size:A4;margin:18mm}}'''
    pieces=[f'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{esc(book["title"])}</title><style>{css}</style><header><div><h1>{esc(book["title"])}</h1><small>{esc(book["subtitle"])} · v{esc(book["version"])}</small></div><a class="download" href="manual.pdf" download>下载 PDF 说明书</a></header><nav>']
    for i,page in enumerate(book['pages'],1):pieces.append(f'<a href="#chapter-{i}">{i:02d}　{esc(page["title"])}</a>')
    pieces.append('</nav><main>')
    for i,page in enumerate(book['pages'],1):
        pieces.append(f'<article id="chapter-{i}"><h2>{i:02d}　{esc(page["title"])}</h2><p class="lead">{esc(page["lead"])}</p>')
        for section in page['sections']:
            if section.get('heading'):pieces.append('<h3>'+esc(section['heading'])+'</h3>')
            for text in section.get('paragraphs',[]):pieces.append('<p>'+esc(text)+'</p>')
            for key,tag in [('steps','ol'),('bullets','ul')]:
                if key in section:pieces.append('<'+tag+'>'+''.join('<li>'+esc(t)+'</li>' for t in section[key])+'</'+tag+'>')
            if section.get('table'):
                rows=section['table'];pieces.append('<table><thead><tr>'+''.join('<th>'+esc(t)+'</th>' for t in rows[0])+'</tr></thead><tbody>')
                for row in rows[1:]:pieces.append('<tr>'+''.join('<td>'+esc(t)+'</td>' for t in row)+'</tr>')
                pieces.append('</tbody></table>')
            if section.get('code'):pieces.append('<pre>'+esc(section['code'])+'</pre>')
            if section.get('note'):pieces.append('<div class="note">'+esc(section['note'])+'</div>')
            if section.get('diagram'):pieces.append('<div class="layout"><div><strong>数据列表</strong><span>数据集 · 搜索 · 对象</span></div><div><strong>三维视图</strong><span>旋转 · 缩放 · 剖面 · 测量表</span></div><div><strong>属性与参数</strong><span>显示 · 剖面 · 导出</span></div></div>')
        pieces.append('</article>')
    pieces.append('</main><footer>ORS Viewer · 本地运行 · 使用说明书 v'+esc(book['version'])+'</footer></html>')
    (ROOT/'viewer/web/manual.html').write_text(''.join(pieces),encoding='utf-8',newline='\n')


def build_pdf(book,font,font_bold):
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import SimpleDocTemplate,Paragraph,Spacer,Table,TableStyle,PageBreak,KeepTogether
    pdfmetrics.registerFont(TTFont('ManualBody',str(font),subfontIndex=0))
    pdfmetrics.registerFont(TTFont('ManualBold',str(font_bold),subfontIndex=0))
    body=ParagraphStyle('body',fontName='ManualBody',fontSize=10,leading=16.3,wordWrap='CJK',spaceAfter=6,textColor=colors.HexColor('#283d4a'))
    title=ParagraphStyle('title',parent=body,fontName='ManualBold',fontSize=24,leading=32,spaceAfter=12,textColor=colors.HexColor('#123f4c'))
    lead=ParagraphStyle('lead',parent=body,fontSize=11,leading=18,spaceAfter=14,textColor=colors.HexColor('#526d78'))
    heading=ParagraphStyle('heading',parent=body,fontName='ManualBold',fontSize=12,leading=19,spaceBefore=10,spaceAfter=6,keepWithNext=True,textColor=colors.HexColor('#16635f'))
    cell=ParagraphStyle('cell',parent=body,fontSize=9,leading=14,spaceAfter=0)
    header_cell=ParagraphStyle('headercell',parent=cell,fontName='ManualBold',textColor=colors.white)
    code=ParagraphStyle('code',parent=body,fontName='Courier',fontSize=8.3,leading=13,wordWrap=None,spaceAfter=0)
    esc=html.escape
    p=lambda t,style=body:Paragraph(esc(t),style)
    output=ROOT/'output/pdf';output.mkdir(parents=True,exist_ok=True)
    path=output/'ORSViewer-User-Manual-zh-CN.pdf'
    width=A4[0]-88
    story=[]
    for i,page in enumerate(book['pages'],1):
        if i>1:story.append(PageBreak())
        story.append(p(f'{i:02d}  '+page['title'],title));story.append(p(page['lead'],lead))
        for section in page['sections']:
            if section.get('heading'):story.append(p(section['heading'],heading))
            for text in section.get('paragraphs',[]):story.append(p(text))
            for j,text in enumerate(section.get('steps',[]),1):story.append(p(f'{j}. '+text))
            for text in section.get('bullets',[]):story.append(p('• '+text))
            if section.get('table'):
                rows=[[p(t,header_cell if j==0 else cell) for t in row] for j,row in enumerate(section['table'])]
                table=Table(rows,colWidths=[width*.32,width*.68],hAlign='LEFT',repeatRows=1)
                padding=3 if i==len(book['pages']) else 6
                table.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#164c54')),('VALIGN',(0,0),(-1,-1),'TOP'),('BOX',(0,0),(-1,-1),.4,colors.HexColor('#d5e3e7')),('INNERGRID',(0,0),(-1,-1),.4,colors.HexColor('#d5e3e7')),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.HexColor('#f3f8f9'),colors.white]),('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),9),('TOPPADDING',(0,0),(-1,-1),padding),('BOTTOMPADDING',(0,0),(-1,-1),padding)]))
                story.extend([table,Spacer(1,9)])
            if section.get('code'):
                box=Table([[Paragraph(esc(section['code']).replace('\n','<br/>'),code)]],colWidths=[width])
                box.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),colors.HexColor('#edf2f5')),('BOX',(0,0),(-1,-1),.4,colors.HexColor('#d7e2e6')),('LEFTPADDING',(0,0),(-1,-1),12),('TOPPADDING',(0,0),(-1,-1),10),('BOTTOMPADDING',(0,0),(-1,-1),10)]));story.extend([box,Spacer(1,9)])
            if section.get('note'):
                box=Table([[p(section['note'])]],colWidths=[width]);box.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),colors.HexColor('#edf8f4')),('LINEBEFORE',(0,0),(0,-1),3,colors.HexColor('#3aa58e')),('LEFTPADDING',(0,0),(-1,-1),12),('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),6)]));story.extend([Spacer(1,4),box])
            if section.get('diagram'):
                rows=[[p('数据列表',heading),p('三维视图',heading),p('属性与参数',heading)],[p('数据集 · 搜索 · 对象',cell),p('旋转 · 缩放 · 剖面',cell),p('显示 · 剖面 · 导出',cell)]]
                box=Table(rows,colWidths=[width*.28,width*.4,width*.32]);box.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),colors.HexColor('#eaf3f4')),('BOX',(0,0),(-1,-1),.5,colors.HexColor('#b7d6da')),('INNERGRID',(0,0),(-1,-1),.3,colors.HexColor('#b7d6da')),('LEFTPADDING',(0,0),(-1,-1),10),('BOTTOMPADDING',(0,0),(-1,-1),10)]));story.extend([box,Spacer(1,9)])
    def frame(canvas,doc):
        canvas.saveState();canvas.setFont('ManualBold',9);canvas.setFillColor(colors.HexColor('#16635f'))
        canvas.drawString(44,A4[1]-28,'ORS VIEWER  /  使用说明书')
        canvas.setFont('ManualBody',8);canvas.setFillColor(colors.HexColor('#67818a'));canvas.drawRightString(A4[0]-44,A4[1]-28,'v'+book['version'])
        canvas.setStrokeColor(colors.HexColor('#d9e5e7'));canvas.line(44,36,A4[0]-44,36)
        canvas.drawString(44,23,'独立文件解析与三维查看');canvas.drawRightString(A4[0]-44,23,str(doc.page));canvas.restoreState()
    doc=SimpleDocTemplate(str(path),pagesize=A4,leftMargin=44,rightMargin=44,topMargin=52,bottomMargin=48,
        title=book['title'],author='ORS Viewer',subject='软件功能与操作说明')
    doc.build(story,onFirstPage=frame,onLaterPages=frame)
    shutil.copy2(path,ROOT/'viewer/web/manual.pdf')
    return path


def main():
    parser=argparse.ArgumentParser();fonts=Path(os.environ.get('WINDIR','C:/Windows'))/'Fonts'
    parser.add_argument('--font',type=Path,default=fonts/'msyh.ttc');parser.add_argument('--font-bold',type=Path,default=fonts/'msyhbd.ttc')
    args=parser.parse_args();book=json.loads((ROOT/'docs/manual_content.json').read_text('utf-8'))
    build_html(book);build_independence();print(build_pdf(book,args.font,args.font_bold))


if __name__=='__main__':main()
