"""Erzeugt kleine Testdateien mit ezdxf fuer den DXF/DWG-Import (src-tauri/fileio/testdata)."""
import sys

import ezdxf
from ezdxf.math import Vec2
from ezdxf.enums import TextEntityAlignment
from ezdxf.render.mleader import ConnectionSide

out = sys.argv[1]


def new_doc():
    doc = ezdxf.new("R2018", setup=False)
    doc.header["$INSUNITS"] = 6
    doc.dimstyles.new("ARCH")
    st = doc.dimstyles.get("ARCH")
    st.dxf.dimasz = 0.25
    st.dxf.dimtxt = 0.25
    st.dxf.dimdec = 2
    return doc, doc.modelspace()


def dims(render):
    doc, msp = new_doc()
    ds = {"dimstyle": "ARCH"}
    items = [
        msp.add_linear_dim(base=(0, 3), p1=(0, 0), p2=(5, 0), **ds),
        msp.add_aligned_dim(p1=(10, 0), p2=(14, 3), distance=1.5, **ds),
        msp.add_radius_dim(center=(20, 0), mpoint=(22, 1), radius=2.0, **ds),
        msp.add_diameter_dim(center=(26, 0), mpoint=(28, 1), radius=2.0, **ds),
        msp.add_angular_dim_3p(base=(34, 4), center=(30, 0), p1=(34, 0), p2=(31, 3), **ds),
        msp.add_angular_dim_cra(center=(40, 0), radius=3, start_angle=10, end_angle=70, distance=4, **ds),
    ]
    if render:
        for d in items:
            d.render()
    doc.saveas(f"{out}/dim_{'block' if render else 'noblock'}.dxf")


def arrows():
    for name, blk in [("tick", "ARCHTICK"), ("dot", "DOT"), ("open", "OPEN30"), ("blank", "CLOSEDBLANK")]:
        doc, msp = new_doc()
        st = doc.dimstyles.get("ARCH")
        st.set_arrows(blk=blk)
        msp.add_linear_dim(base=(0, 3), p1=(0, 0), p2=(5, 0), dimstyle="ARCH").render()
        doc.saveas(f"{out}/dim_arrow_{name}.dxf")


def leaders():
    from ezdxf.render.mleader import LeaderType
    doc, msp = new_doc()
    msp.add_leader([(0, 0), (2, 2), (4, 2)], dimstyle="ARCH")
    sp = msp.add_leader([(0, 5), (2, 7), (4, 6), (6, 7)], dimstyle="ARCH")
    sp.dxf.path_type = 1
    ml = msp.add_multileader_mtext("Standard")
    ml.set_content("Pos 1\\PZeile 2", char_height=0.25)
    ml.set_arrow_properties(name="DOT", size=0.2)
    ml.set_connection_properties(landing_gap=0.1, dogleg_length=0.5)
    ml.add_leader_line(ConnectionSide.left, [(10, 0), (11, 1)])
    ml.build(insert=Vec2(13, 2))
    ml2 = msp.add_multileader_mtext("Standard")
    ml2.set_content("Spline", char_height=0.25)
    ml2.set_arrow_properties(name="", size=0.2)
    ml2.set_connection_properties(landing_gap=0.1, dogleg_length=0.0)
    ml2.set_leader_properties(leader_type=LeaderType.splines)
    ml2.add_leader_line(ConnectionSide.left, [(10, 6), (11, 8), (12, 7)])
    ml2.build(insert=Vec2(14, 8))
    blk = doc.blocks.new("TAG")
    blk.add_circle((0, 0), 0.5)
    blk.add_attdef("NR", (0, 0), text="000", dxfattribs={"height": 0.3})
    ml3 = msp.add_multileader_block("Standard")
    ml3.set_content("TAG", scale=1.0)
    ml3.set_attribute("NR", "42")
    ml3.set_arrow_properties(name="OPEN30", size=0.2)
    ml3.add_leader_line(ConnectionSide.left, [(20, 0), (21, 1)])
    ml3.build(insert=Vec2(24, 2))
    doc.saveas(f"{out}/leaders.dxf")


def texts():
    doc, msp = new_doc()
    y = 0
    for h in (
        TextEntityAlignment.LEFT,
        TextEntityAlignment.CENTER,
        TextEntityAlignment.RIGHT,
        TextEntityAlignment.MIDDLE_CENTER,
        TextEntityAlignment.TOP_LEFT,
        TextEntityAlignment.BOTTOM_RIGHT,
        TextEntityAlignment.ALIGNED,
        TextEntityAlignment.FIT,
    ):
        t = msp.add_text("Wand 12%%d", height=0.3, dxfattribs={"layer": "T"})
        if h in (TextEntityAlignment.ALIGNED, TextEntityAlignment.FIT):
            t.set_placement((0, y), (6, y), align=h)
        else:
            t.set_placement((0, y), align=h)
        y += 1
    msp.add_text("Rotiert", height=0.3, rotation=30, dxfattribs={"width": 0.5}).set_placement((10, 0))
    mt = msp.add_mtext(
        "{\\fArial|b1;Fett}\\PZeile \\H2x;gross\\P\\S1/2; \\L\\~u\\l",
        dxfattribs={"char_height": 0.25, "width": 5, "attachment_point": 5, "rotation": 15},
    )
    mt.dxf.insert = (20, 5)
    doc.saveas(f"{out}/texts.dxf")


def layouts():
    doc, msp = new_doc()
    msp.add_line((0, 0), (10, 0))
    lay = doc.layouts.new("A3 Grundriss")
    lay.add_line((0, 0), (420, 0))
    lay.add_text("Plankopf", height=5).set_placement((10, 10))
    doc.saveas(f"{out}/layouts.dxf")


dims(True)
dims(False)
arrows()
leaders()
texts()
layouts()
print("ok")
