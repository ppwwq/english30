"""Build full-size, content-addressed JPEG print masters from the verified paper scans."""
import hashlib
import json
from pathlib import Path
from io import BytesIO
from PIL import Image

root = Path(__file__).resolve().parents[1]
web = root / 'web'
out = web / 'papers/print'
out.mkdir(exist_ok=True)
catalogue = json.loads((web / 'papers/catalogue.json').read_text('utf-8'))
sources = {s['id']: s for s in catalogue['sources']}
checksums = {f['path']: f['sha256'] for f in json.loads((root/'assets-manifest.json').read_text('utf-8'))['files']}
# Inclusive scan ranges, checked at the booklet covers and end pages.
# 2020 pages 16–18 duplicate the end of B1 and the Data File cover.
ranges = {
    '2012-practice': [(1,8),(18,21)], '2014-exam': [(22,29),(30,33)],
    '2015-exam': [(1,12),(25,28)], '2016-exam': [(1,8),(28,31)],
    '2017-exam': [(1,9),(19,22)], '2018-exam': [(1,10),(11,14)],
    '2019-exam': [(1,12),(13,16)], '2020-exam': [(1,11),(12,15)],
    '2021-exam': [(1,7),(28,31)], '2022-exam': [(1,12),(24,27)],
}
data_ends={'2012-practice':17,'2014-exam':10,'2015-exam':24,'2016-exam':17,'2017-exam':18,
           '2018-exam':24,'2019-exam':36,'2020-exam':27,'2021-exam':17,'2022-exam':23}

def master_pages(source,part,start,stop,data=False):
    pages = []
    for n in range(start,stop+1):
        scan = source['pages'][n-1]
        rel = scan['src'].removeprefix('./')
        original = (web/rel).read_bytes()
        digest = hashlib.sha256(original).hexdigest()
        assert digest == checksums[rel], rel
        image = Image.open(BytesIO(original)).convert('RGB')
        # Keep the actual pixel dimensions; catalogue dimensions can be rounded display sizes.
        buf = BytesIO()
        image.save(buf,'JPEG',quality=96,subsampling=0)
        jpeg = buf.getvalue()
        sha = hashlib.sha256(jpeg).hexdigest()
        target = out/(sha+'.jpg')
        if not target.exists(): target.write_bytes(jpeg)
        pages.append(dict(key=source['id']+':'+str(n),part=part,number=n,source=source['id'],
                          originalHash=digest,src=rel,master=sha,width=image.width,height=image.height,
                          label=f'B1 Data File · 来源第 {n} 页' if data else f'Part {part} · 原卷第 {n} 页',attachment=data))
    return pages

books = {}
for path in sorted((web/'papers/practice').glob('*.json')):
    lesson = json.loads(path.read_text('utf-8'))
    p = lesson['paper']
    part = p['part']
    if part not in ('A','B1'):
        continue
    key = p['sessionId']+'-'+part
    if key not in books:
        source = sources[p['questionSourceId']]
        assert source['role']=='question' and not source['containsAnswers']
        if len(source['parts'])==1:
            start,stop = 1,len(source['pages'])
        else:
            start,stop = ranges[p['sessionId']][('A','B1').index(part)]
        pages = master_pages(source,part,start,stop)
        data = []
        if part=='B1':
            ref=p['dataFile']
            doc=sources[ref['sourceId']]
            if doc['role']=='data' and not doc['containsAnswers']:
                data=master_pages(doc,part,1,len(doc['pages']),True)
            elif p['sessionId'] in data_ends:
                data=master_pages(source,part,ref['page'],data_ends[p['sessionId']],True)
            elif doc['id']==source['id']:
                # Independent B1+DF scans already contain these originals.
                for page in pages:
                    n=page['number']
                    if (p['year']==2025 and n<=10) or (p['year']==2023 and n>=5):
                        page['label']=f'B1 Data File · 原卷第 {n} 页'
        books[key] = dict(year=p['year'],variant=p['variant'],part=part,pages=pages,data=data,taskChoices=[])
    books[key]['taskChoices'].append(dict(task=p['task'],lessonId=lesson['id'],page=p['questionPage']))
(web/'papers/answer-books.json').write_text(json.dumps(books,ensure_ascii=False,separators=(',',':'))+'\n','utf-8')
print(len(books),'books;',sum(len(b['pages']) for b in books.values()),'original pages')
