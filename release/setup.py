from setuptools import setup, find_packages

with open("requirements.txt") as f:
    install_requires = f.read().strip().split("\n")

setup(
    name="betime_solution",
    version="1.0.0",
    description="Betime Enterprise Solution — PMO + AI Secretary + Finance + Compliance + Knowledge",
    author="Betime Solution Co., Ltd.",
    author_email="admin@betime.co.th",
    packages=find_packages(),
    zip_safe=False,
    include_package_data=True,
    install_requires=install_requires,
)
